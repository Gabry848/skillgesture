# Skillgesture

Skillgesture è un server MCP locale per organizzare e fornire skill agli agenti AI. Le skill sono conservate in un archivio centrale, classificate come **gruppo → skill → sottoskill** e caricate integralmente solo quando l'agente le richiede.

## Funzionalità MVP

- archivio centrale in `~/.skillgesture`;
- contenuti delle skill in Markdown;
- catalogo, associazioni e sessioni persistenti in JSON;
- skill globali o associate a percorsi esatti;
- caricamento contemporaneo di più cartelle;
- indice leggero senza contenuti Markdown;
- lettura on-demand;
- creazione e modifica di gruppi, skill e sottoskill;
- abilitazione e disabilitazione dei nodi;
- sessioni durevoli e indipendenti per più agenti;
- scritture atomiche e lock condiviso tra processi.

## Requisiti

- Node.js 24 o successivo
- npm 12 o successivo

## Installazione

```bash
npm install
```

Per rendere disponibile il comando `skillgesture` globalmente durante lo sviluppo:

```bash
npm link
```

## Avvio

```bash
npm start
```

Il server usa il trasporto MCP `stdio`. I messaggi diagnostici vengono scritti su `stderr`, mentre `stdout` è riservato al protocollo MCP.

Esempio di configurazione di un client MCP:

```json
{
  "mcpServers": {
    "skillgesture": {
      "command": "node",
      "args": ["/percorso/assoluto/skillgesture/src/index.js"]
    }
  }
}
```

Per usare una directory di storage differente:

```bash
SKILLGESTURE_HOME=/percorso/alternativo npm start
```

## I tre tool MCP

### `skill_manage`

Gestisce sessioni, catalogo e associazioni. Le azioni disponibili sono:

- `session.open`
- `session.configure`
- `session.list`
- `group.upsert`
- `skill.upsert`
- `subskill.upsert`
- `node.setEnabled`
- `association.set`

### `skill_tree`

Restituisce l'albero leggero delle skill applicabili a una sessione. Include metadati e provenienza, ma non il contenuto Markdown.

### `skill_read`

Legge il Markdown di una singola skill o sottoskill attiva.

## Flusso consigliato per un agente

### 1. Creare una sessione

Ogni agente crea una sessione una sola volta:

```json
{
  "action": "session.open",
  "data": {
    "label": "coding-agent",
    "folders": [
      "/Users/example/projects/api",
      "/Users/example/projects/shared"
    ]
  }
}
```

La risposta contiene un UUID:

```json
{
  "ok": true,
  "session": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac"
  },
  "resumed": false
}
```

L'agente deve conservare e riutilizzare questo `sessionId`.

### 2. Riprendere una sessione

Dopo un riavvio del server:

```json
{
  "action": "session.open",
  "data": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac"
  }
}
```

Un ID sconosciuto non crea implicitamente una nuova sessione.

### 3. Modificare le cartelle della sessione

```json
{
  "action": "session.configure",
  "data": {
    "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
    "mode": "add",
    "folders": ["/Users/example/projects/another-project"]
  }
}
```

`mode` può essere `replace`, `add` o `remove`.

### 4. Consultare l'indice

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "includeDisabled": false
}
```

### 5. Leggere una skill on-demand

```json
{
  "sessionId": "6de1fdba-aec8-4dc7-b03c-1e21e1ae58ac",
  "groupId": "coding",
  "skillId": "nodejs",
  "subskillId": "testing"
}
```

`subskillId` è facoltativo.

## Creazione del catalogo

### Gruppo

```json
{
  "action": "group.upsert",
  "data": {
    "id": "coding",
    "name": "Coding",
    "description": "Skill di sviluppo"
  }
}
```

### Skill globale

```json
{
  "action": "skill.upsert",
  "data": {
    "groupId": "coding",
    "id": "git",
    "name": "Git",
    "description": "Gestione del versionamento",
    "global": true,
    "markdown": "# Git\n\nIstruzioni della skill."
  }
}
```

### Skill associabile a cartelle

```json
{
  "action": "skill.upsert",
  "data": {
    "groupId": "coding",
    "id": "nodejs",
    "name": "Node.js",
    "global": false,
    "markdown": "# Node.js\n\nIstruzioni della skill."
  }
}
```

### Sottoskill

```json
{
  "action": "subskill.upsert",
  "data": {
    "groupId": "coding",
    "skillId": "nodejs",
    "id": "testing",
    "name": "Node testing",
    "markdown": "# Node testing\n\nUsare node:test."
  }
}
```

Le sottoskill ereditano lo scope della skill genitore.

## Associazione a una cartella

```json
{
  "action": "association.set",
  "data": {
    "folder": "/Users/example/projects/api",
    "skills": [
      {
        "groupId": "coding",
        "skillId": "nodejs"
      }
    ]
  }
}
```

`association.set` sostituisce l'intero insieme di skill della cartella. Un array vuoto elimina l'associazione.

Le associazioni sono basate sul percorso canonico esatto:

- un'associazione a `/projects/api` non si applica automaticamente a `/projects/api/packages/web`;
- le cartelle devono esistere quando vengono caricate o associate;
- una sessione può contenere più cartelle e riceve l'unione deduplicata delle relative skill.

## Abilitazione e disabilitazione

```json
{
  "action": "node.setEnabled",
  "data": {
    "ref": {
      "groupId": "coding",
      "skillId": "nodejs"
    },
    "enabled": false
  }
}
```

Disabilitare un gruppo disabilita tutte le skill discendenti. Disabilitare una skill rende non leggibili anche le sue sottoskill. `skill_tree` può mostrare i nodi disabilitati usando `includeDisabled: true`.

## Concorrenza e versioni

Più processi MCP possono utilizzare lo stesso archivio. Le sessioni sono salvate separatamente e le mutazioni sono serializzate tramite lock inter-processo.

Le operazioni di aggiornamento accettano `expectedVersion`; `association.set` accetta `expectedRevision`. Se un altro agente ha già modificato il dato, Skillgesture restituisce `VERSION_CONFLICT` invece di sovrascrivere silenziosamente la modifica.

## Archivio centrale

```text
~/.skillgesture/
├── catalog.json
├── associations.json
├── sessions/
│   └── <session-id>.json
└── skills/
    └── <group-id>/
        └── <skill-id>/
            ├── versions/
            │   └── <version>.md
            └── subskills/
                └── <subskill-id>/
                    └── versions/
                        └── <version>.md
```

Le versioni Markdown sono immutabili. Il catalogo punta alla versione attiva, evitando che una lettura osservi contenuti parzialmente aggiornati.

## Test

```bash
npm test
```

I test usano directory temporanee e non modificano `~/.skillgesture`.

## Licenza

ISC
