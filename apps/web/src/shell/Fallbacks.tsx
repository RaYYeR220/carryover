import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { buttonClass } from '../ui/Button';
import { DotWordmark } from '../ui/DotWordmark';
import s from './Shell.module.css';

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className={s.page}>
      <div className={s.card}>
        <Link to="/" aria-label="Carryover, home">
          <DotWordmark height={19} />
        </Link>
        <h1>{title}</h1>
        <p>{body}</p>
        <div className={s.actions}>
          <Link
            className={buttonClass({ variant: 'ink', shape: 'pill', size: 'lg' })}
            to="/app/new"
          >
            Start a call
          </Link>
          <Link className={buttonClass({ variant: 'line', shape: 'pill', size: 'lg' })} to="/">
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}

export function NotFound() {
  return (
    <Message
      title="Nothing here."
      body="That page doesn’t exist. Your calls and profile are safe on this device."
    />
  );
}

export function RouteError() {
  const err = useRouteError();
  if (isRouteErrorResponse(err) && err.status === 404) return <NotFound />;
  return (
    <Message
      title="Something broke."
      body="This page hit an error. Reload to try again; your calls and profile are safe on this device."
    />
  );
}
