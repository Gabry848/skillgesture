import { useId, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { Entity } from '../types';
import { entityName } from '../types';

export interface CategoryChoice { id: string; name: string; isNew?: boolean; archived?: boolean }
export const catalogId = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');

export function CategoryPicker({ categories, value, onChange, disabled }: {
  categories: Entity[]; value?: CategoryChoice; onChange: (value?: CategoryChoice) => void; disabled: boolean;
}) {
  const inputId = useId();
  const [input, setInput] = useState(value?.name ?? '');
  const text = input.trim();
  const id = catalogId(text);
  const searching = input !== value?.name;
  const options: CategoryChoice[] = categories.filter((category) => !searching || entityName(category).toLowerCase().includes(text.toLowerCase())
    || category.ref.includes(text.toLowerCase()) || category.ref === id)
    .map((category) => ({ id: category.ref, name: entityName(category), archived: category.deleted }));
  if (text && id && !categories.some((category) => category.ref === id || entityName(category).toLowerCase() === text.toLowerCase())) {
    options.push({ id, name: text, isNew: true });
  }
  return <div className="category-picker"><Combobox.Root items={options} value={value ?? null} inputValue={input} filter={null}
    disabled={disabled} isItemEqualToValue={(a, b) => a.id === b.id && !!a.isNew === !!b.isNew}
    itemToStringLabel={(item) => item.name} itemToStringValue={(item) => item.id}
    onInputValueChange={(text, details) => { setInput(text); if (details.reason === 'input-change' || details.reason === 'input-clear') onChange(undefined); }}
    onValueChange={(choice) => { onChange(choice ?? undefined); setInput(choice?.name ?? ''); }}>
    <label htmlFor={inputId}>Category</label>
    <div className="category-picker-control"><Combobox.Input id={inputId} placeholder="Choose or create a category" required autoComplete="off" />
      <Combobox.Trigger aria-label="Choose category"><ChevronDown size={15} /></Combobox.Trigger>
    </div>
    <Combobox.Portal><Combobox.Positioner sideOffset={6} className="category-picker-positioner"><Combobox.Popup className="category-picker-popup">
      <Combobox.List>{(item: CategoryChoice) => <Combobox.Item key={`${item.isNew ? 'new:' : ''}${item.id}`} value={item} disabled={item.archived} className="category-picker-option">
        {item.isNew && <Plus size={14} />}<span>{item.isNew ? `New category “${item.name}”` : `${item.name}${item.archived ? ' (archived)' : ''}`}</span>
        <Combobox.ItemIndicator><Check size={14} /></Combobox.ItemIndicator>
      </Combobox.Item>}</Combobox.List>
      <Combobox.Empty className="category-picker-empty">No matching categories</Combobox.Empty>
    </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
  </Combobox.Root></div>;
}
