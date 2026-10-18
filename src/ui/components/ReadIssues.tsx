import type { Cap, Failure } from '../../discovery/types';

/**
 * What could not be read, and where a cap stopped a walk. Shown wherever a
 * view model carries failures, so a failed read never passes for "none".
 */
export function ReadIssues({ failures, caps }: { failures: Failure[]; caps: Cap[] }) {
  if (failures.length === 0 && caps.length === 0) return null;
  return (
    <div className="read-issues" role="status">
      {failures.map((f, i) => (
        <p key={`f${i}`} className="mono-label error">
          Could not read {f.source}: {f.message}. What is shown may be incomplete.
        </p>
      ))}
      {caps.map((c, i) => (
        <p key={`c${i}`} className="mono-label">
          {c.source}: showing the first {c.limit}; more exist.
        </p>
      ))}
    </div>
  );
}
