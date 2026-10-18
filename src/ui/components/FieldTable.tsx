import { useState } from 'react';
import type { FieldRow, FieldValue } from '../../kinds/fields';
import { shortId } from '../format';
import { CopyButton } from './CopyButton';

const CLIP = 160;
const HEX_CLIP = 40;

function Clipped({ text, mono }: { text: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CLIP;
  return (
    <>
      <span className={mono ? 'mono field-text' : 'field-text'}>
        {long && !open ? `${text.slice(0, CLIP)}…` : text}
      </span>
      {long && (
        <>
          {' '}
          <button type="button" className="link-button" onClick={() => setOpen(!open)}>
            {open ? 'show less' : `show all ${text.length} characters`}
          </button>
        </>
      )}
    </>
  );
}

function Value({ name, value }: { name: string; value: FieldValue }) {
  switch (value.kind) {
    case 'identifier':
      return (
        <>
          <span className="mono" title={value.id}>
            {shortId(value.id, 8)}
          </span>{' '}
          <CopyButton text={value.id} label={`Copy ${name}`} />
        </>
      );
    case 'bytes': {
      const shown =
        value.hex.length > HEX_CLIP ? `${value.hex.slice(0, HEX_CLIP)}…` : value.hex || '(empty)';
      return (
        <>
          <span className="mono" title={`${value.hex.length / 2} bytes`}>
            {value.hex ? `0x${shown}` : shown}
          </span>{' '}
          {value.hex && <CopyButton text={value.hex} label={`Copy ${name} as hex`} />}
        </>
      );
    }
    case 'json':
      return (
        <pre className="mono field-json">
          <Clipped text={value.text} mono />
        </pre>
      );
    case 'text':
      return <Clipped text={value.text} />;
  }
}

/** A document's fields as a key/value table (the generic kind's contender view). */
export function FieldTable({ rows }: { rows: FieldRow[] }) {
  return (
    <dl className="kv-table">
      {rows.map((row) => (
        <div key={row.name}>
          <dt className="mono-label">{row.name}</dt>
          <dd>
            <Value name={row.name} value={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
