/** The problems a form's input has, one line each. */
export function FieldProblems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="field-problems">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}
