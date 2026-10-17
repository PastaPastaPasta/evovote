/** The problems a form's input has, one line each. */
export function FieldProblems({ problems }: { problems: string[] }) {
  return (
    <>
      {problems.map((p) => (
        <p key={p} className="mono-label error">
          {p}
        </p>
      ))}
    </>
  );
}
