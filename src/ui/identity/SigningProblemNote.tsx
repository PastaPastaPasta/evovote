import { useIdentitySession, type SigningProblem } from '../../identity/session';
import { AddStepKey } from './AddStepKey';

/**
 * Why a step cannot be signed, with the way forward: add a key for the step
 * (signed in with Dash Wallet), renew the wallet sign-in, or sign in.
 */
export function SigningProblemNote({ problem }: { problem: SigningProblem }) {
  const session = useIdentitySession();
  if (problem.reason === 'needs-key' && session?.via === 'wallet') return <AddStepKey message={problem.message} />;
  return (
    <p className="page-note error">
      {problem.message}{' '}
      {problem.reason === 'renew' ? (
        <a href="#/me">Renew on my identity page</a>
      ) : problem.reason === 'signed-out' ? (
        <a href="#/me">Sign in</a>
      ) : (
        <a href="#/me">Open my identity</a>
      )}
    </p>
  );
}
