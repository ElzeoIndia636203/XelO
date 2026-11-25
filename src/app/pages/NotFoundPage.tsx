import { Link } from 'react-router-dom';
import { Card, PageHead, Wordmark } from '../../components/ui';
import { homeForRole } from '../../lib/logic/routing';
import { useSession } from '../../lib/session';

export function NotFoundPage() {
  const { profile } = useSession();
  const home = profile ? homeForRole(profile.role) : '/login';

  return (
    <main style={{ maxWidth: 540, margin: '64px auto', padding: '0 16px' }}>
      <div style={{ marginBottom: 24 }}>
        <Wordmark />
      </div>
      <PageHead kicker="404" title="Page not found" lead="The page you requested does not exist." />
      <Card>
        <Link className="btn btn-primary" to={home}>
          {profile ? 'Go to your workspace' : 'Go to sign in'}
        </Link>
      </Card>
    </main>
  );
}
