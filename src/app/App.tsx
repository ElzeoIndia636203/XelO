import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Loading } from '../components/ui';
import { SessionProvider, useSession } from '../lib/session';
import { homeForRole } from '../lib/logic/routing';
import { RequireRole } from './components/RequireRole';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

const AdminConsole = lazy(() => import('./pages/admin/AdminConsole'));
const FacultyCoursesList = lazy(() => import('./pages/faculty/CoursesListPage'));
const FacultyWorkspace = lazy(() => import('./pages/faculty/FacultyWorkspace'));
const StudentHome = lazy(() =>
  import('./pages/student/StudentHomePage').then((m) => ({ default: m.StudentHomePage })),
);
const StudentLab = lazy(() =>
  import('./pages/student/StudentLabPage').then((m) => ({ default: m.StudentLabPage })),
);
const StudentTest = lazy(() =>
  import('./pages/student/TestAttemptPage').then((m) => ({ default: m.TestAttemptPage })),
);
const StudentClassroom = lazy(() =>
  import('./pages/student/StudentClassroomPage').then((m) => ({
    default: m.StudentClassroomPage,
  })),
);
const StudentLabFile = lazy(() =>
  import('./pages/student/StudentLabFilePage').then((m) => ({
    default: m.StudentLabFilePage,
  })),
);
const FacultyStudentLabFile = lazy(() =>
  import('./pages/student/StudentLabFilePage').then((m) => ({
    default: m.FacultyStudentLabFilePage,
  })),
);
const PublicVerify = lazy(() =>
  import('./pages/PublicVerifyPage').then((m) => ({
    default: m.PublicVerifyPage,
  })),
);
const StudentEndsem = lazy(() =>
  import('./pages/student/StudentEndsemPage').then((m) => ({
    default: m.StudentEndsemPage,
  })),
);
const StudentProctoredIde = lazy(() =>
  import('./pages/student/StudentProctoredIdePage').then((m) => ({
    default: m.StudentProctoredIdePage,
  })),
);
const HodConsole = lazy(() => import('./pages/hod/HodConsole'));
const OversightConsole = lazy(() => import('./pages/oversight/OversightConsole'));

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
          <LazyWrap>
            <StudentHome />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/lab',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentLab />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/lab/:sessionId',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentLab />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/test/:sessionId/:bank',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentTest />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/classroom',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentClassroom />
          </LazyWrap>
        </RequireRole>
      ),
    },
    {
      path: '/student/lab-file',
      element: (
        <RequireRole allow={['student']}>
          <LazyWrap>
            <StudentLabFile />
          </LazyWrap>
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
  { basename: '/app' },
);

export function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
