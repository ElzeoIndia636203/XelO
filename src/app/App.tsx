import { lazy, Suspense, type ComponentType } from 'react';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useRouteError,
} from 'react-router-dom';
import { Card, Loading } from '../components/ui';
import { SessionProvider, useSession } from '../lib/session';
import { STUDENT_ASSESSMENT_ONLY } from '../lib/studentMode';
import { homeForRole } from '../lib/logic/routing';
import { RequireRole } from './components/RequireRole';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

const CHUNK_RELOAD_KEY = 'xeio_chunk_reload';

function lazyRetry<T extends ComponentType<object>>(
  loader: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const mod = await loader();
      window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      return mod;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isChunkError =
        msg.includes('Importing a module script failed') ||
        msg.includes('Failed to fetch dynamically imported module') ||
        msg.includes('error loading dynamically imported module');
      if (isChunkError && window.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== '1') {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
        window.location.reload();
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}

function RouteErrorBoundary() {
  const err = useRouteError();
  const msg = err instanceof Error ? err.message : 'Something went wrong while loading this page.';
  return (
    <main style={{ maxWidth: 520, margin: '64px auto', padding: '0 16px' }}>
      <Card title="Could not open page">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{msg}</p>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </Card>
    </main>
  );
}

const AdminConsole = lazyRetry(() => import('./pages/admin/AdminConsole'));
const FacultyCoursesList = lazyRetry(() => import('./pages/faculty/CoursesListPage'));
const FacultyWorkspace = lazyRetry(() => import('./pages/faculty/FacultyWorkspace'));
const StudentHome = lazyRetry(() =>
  import('./pages/student/StudentHomePage').then((m) => ({ default: m.StudentHomePage })),
);
const StudentLab = lazyRetry(() =>
  import('./pages/student/StudentLabPage').then((m) => ({ default: m.StudentLabPage })),
);
const StudentTest = lazyRetry(() =>
  import('./pages/student/TestAttemptPage').then((m) => ({ default: m.TestAttemptPage })),
);
const StudentClassroom = lazyRetry(() =>
  import('./pages/student/StudentClassroomPage').then((m) => ({
    default: m.StudentClassroomPage,
  })),
);
const StudentLabFile = lazyRetry(() =>
  import('./pages/student/StudentLabFilePage').then((m) => ({
    default: m.StudentLabFilePage,
  })),
);
const StudentInstantTest = lazyRetry(() =>
  import('./pages/student/StudentInstantTestPage').then((m) => ({
    default: m.StudentInstantTestPage,
  })),
);
const FacultyStudentLabFile = lazyRetry(() =>
  import('./pages/student/StudentLabFilePage').then((m) => ({
    default: m.FacultyStudentLabFilePage,
  })),
);
const PublicVerify = lazyRetry(() =>
  import('./pages/PublicVerifyPage').then((m) => ({
    default: m.PublicVerifyPage,
  })),
);
const StudentEndsem = lazyRetry(() =>
  import('./pages/student/StudentEndsemPage').then((m) => ({
    default: m.StudentEndsemPage,
  })),
);
const StudentProctoredIde = lazyRetry(() =>
  import('./pages/student/StudentProctoredIdePage').then((m) => ({
    default: m.StudentProctoredIdePage,
  })),
);
const HodConsole = lazyRetry(() => import('./pages/hod/HodConsole'));
const OversightConsole = lazyRetry(() => import('./pages/oversight/OversightConsole'));

function RootRedirect() {
  const { session, profile, restored } = useSession();
  if (!restored) {
    return (
      <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
        <Loading label="Restoring session…" />
      </main>
    );
  }
  if (!session || !profile) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={homeForRole(profile.role)} replace />;
}

function LazyWrap({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

const router = createBrowserRouter(
  [
    {
      errorElement: <RouteErrorBoundary />,
      children: [
        { path: '/', element: <RootRedirect /> },
    { path: '/login', element: <LoginPage /> },
    {
      path: '/admin',
      element: (
        <RequireRole allow={['super_admin']}>
          <LazyWrap>
            <AdminConsole />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/faculty',
      element: (
        <RequireRole allow={['faculty', 'hod']}>
          <LazyWrap>
            <FacultyCoursesList />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/faculty/c/:courseId',
      element: (
        <RequireRole allow={['faculty', 'hod']}>
          <LazyWrap>
            <FacultyWorkspace />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/faculty/c/:courseId/lab-file/:studentId',
      element: (
        <RequireRole allow={['faculty', 'hod']}>
          <LazyWrap>
            <FacultyStudentLabFile />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/faculty/c/:courseId/:step',
      element: (
        <RequireRole allow={['faculty', 'hod']}>
          <LazyWrap>
            <FacultyWorkspace />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/verify/:courseId/:studentId',
      element: (
        <LazyWrap>
          <PublicVerify />
        </LazyWrap>
      ),
    },
    {
      path: '/student',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentHome />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/lab',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentLab />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/lab/:sessionId',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentLab />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/test/:sessionId/:bank',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentTest />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/classroom',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentClassroom />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/lab-file',
      element: (
        <RequireRole allow={['student']}>
          {STUDENT_ASSESSMENT_ONLY ? (
            <Navigate to="/student/endsem" replace />
          ) : (
            <LazyWrap>
              <StudentLabFile />
            </LazyWrap>
          )}
        </RequireRole>
      ),
    },
    {
      path: '/student/endsem',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentEndsem />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/endsem/exam/:paperId',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentProctoredIde />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/instant-test/:attemptId',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentInstantTest />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/instant/:attemptId',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentInstantTest />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/instant',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentHome />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/hod',
      element: (
        <RequireRole allow={['hod']}>
          <LazyWrap>
            <HodConsole />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/oversight',
      element: (
        <RequireRole allow={['vc', 'coe', 'dean']}>
          <LazyWrap>
            <OversightConsole />
          </LazyWrap>
        </RequireRole>
      ),
    },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: '/app' },
);

export function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
