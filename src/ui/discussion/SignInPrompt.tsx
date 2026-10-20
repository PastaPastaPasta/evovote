/**
 * What a signed-out reader sees where the comment box would be. One place,
 * so the sign-in method (key paste today, Dash Wallet App Connect next) can
 * change without touching the discussion.
 */
export function SignInPrompt({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'signin-prompt compact' : 'signin-prompt'}>
      <div className="signin-prompt-text">
        <strong>{compact ? 'Sign in to reply' : 'Join the discussion'}</strong>
        {!compact && <span>Sign in with your Dash Platform identity to comment and reply.</span>}
      </div>
      <a className="vote-button" href="#/me">
        Sign in
      </a>
    </div>
  );
}
