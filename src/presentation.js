// Project validated registry results for agents; storage and authorization stay in the registry.
export function minimalRead(result) {
  if (result.ok === false) return result;
  if (result.items) return { items: result.items.map(minimalRead) };
  if (result.resource) {
    const { content, encoding, mimeType } = result.resource;
    return {
      ...(result.ok === undefined ? {} : { ok: result.ok }),
      resource: {
        content,
        encoding,
        mimeType,
      },
    };
  }
  return {
    ...(result.ok === undefined ? {} : { ok: result.ok }),
    markdown: result.markdown,
    ...(result.resources.length === 0 ? {} : {
      resources: result.resources.map(({ path }) => ({ path })),
    }),
  };
}

function minimalSession({ sessionId, version, folders, label }) {
  return {
    sessionId,
    version,
    ...(folders.length === 0 ? {} : { folders }),
    ...(label ? { label } : {}),
  };
}

export function minimalManage(action, result) {
  switch (action) {
    case 'session.open':
    case 'session.configure':
      return {
        session: minimalSession(result.session),
        ...(result.discovery === undefined ? {} : { discovery: result.discovery }),
      };
    case 'session.list':
      return { sessions: result.sessions.map(minimalSession) };
    case 'group.upsert':
      return { version: result.group.version };
    case 'skill.upsert':
      return { version: result.skill.version };
    case 'subskill.upsert':
      return { version: result.subskill.version };
    case 'node.setEnabled':
      return { version: result.version };
    case 'association.set':
      return { folder: result.folder, associationsRevision: result.associationsRevision };
    default:
      throw new TypeError(`Unsupported management action: ${action}`);
  }
}
