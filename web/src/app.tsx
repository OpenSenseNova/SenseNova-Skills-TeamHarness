import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { api } from './api/client';

const LoginPage = lazy(() => import('./auth/AuthPages').then((module) => ({ default: module.LoginPage })));
const RegisterPage = lazy(() => import('./auth/AuthPages').then((module) => ({ default: module.RegisterPage })));
const VerifyEmailPage = lazy(() => import('./auth/AuthPages').then((module) => ({ default: module.VerifyEmailPage })));
const WorkspaceJoinPage = lazy(() => import('./auth/AuthPages').then((module) => ({ default: module.WorkspaceJoinPage })));
const WorkspaceEntry = lazy(() => import('./workspace/WorkspaceShell').then((module) => ({ default: module.WorkspaceEntry })));
const WorkspaceHome = lazy(() => import('./workspace/WorkspaceShell').then((module) => ({ default: module.WorkspaceHome })));
const WorkspaceShell = lazy(() => import('./workspace/WorkspaceShell').then((module) => ({ default: module.WorkspaceShell })));
const ConversationPage = lazy(() => import('./workspace/ConversationPage').then((module) => ({ default: module.ConversationPage })));
const AgentsPage = lazy(() => import('./workspace/AgentsPage').then((module) => ({ default: module.AgentsPage })));
const AgentDetailPage = lazy(() => import('./workspace/AgentDetailPage').then((module) => ({ default: module.AgentDetailPage })));
const MembersPage = lazy(() => import('./workspace/MembersPage').then((module) => ({ default: module.MembersPage })));
const SettingsPage = lazy(() => import('./workspace/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const ProjectHome = lazy(() => import('./workspace/ProjectPages').then((module) => ({ default: module.ProjectHome })));
const ProjectSettingsPage = lazy(() => import('./workspace/ProjectPages').then((module) => ({ default: module.ProjectSettingsPage })));
const ProjectsPage = lazy(() => import('./workspace/ProjectPages').then((module) => ({ default: module.ProjectsPage })));
const ProjectMembersPage = lazy(() => import('./workspace/ProjectPages').then((module) => ({ default: module.ProjectMembersPage })));
const WorkItemBoardPage = lazy(() => import('./workspace/WorkItemBoardPage').then((module) => ({ default: module.WorkItemBoardPage })));
const ArtifactPage = lazy(() => import('./workspace/ArtifactPage').then((module) => ({ default: module.ArtifactPage })));

export const sessionQueryKey = ['auth', 'session'] as const;

function AuthGuard() {
  const location = useLocation();
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: api.session });
  if (session.isPending) return <div className="full-page-center"><Spin size="large" /></div>;
  if (session.isError) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <Outlet />;
}

class ApplicationErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application render failed.', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="full-page-center page-background">
          <Result
            status="error"
            title="页面加载失败"
            subTitle="前端遇到了未处理错误，请刷新后重试。"
            extra={<Button type="primary" onClick={() => window.location.reload()}>刷新页面</Button>}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

export function Application() {
  return (
    <ApplicationErrorBoundary>
      <Suspense fallback={<div className="full-page-center"><Spin size="large" /></div>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route element={<AuthGuard />}>
            <Route path="/" element={<WorkspaceEntry />} />
            <Route path="/join/:token" element={<WorkspaceJoinPage />} />
            <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
              <Route index element={<WorkspaceHome />} />
              <Route path="c/:conversationId" element={<ConversationPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="p/:projectId" element={<ProjectSettingsPage />} />
              <Route path="p/:projectId/resources" element={<ProjectHome />} />
              <Route path="p/:projectId/c/:conversationId" element={<ConversationPage />} />
              <Route path="p/:projectId/members" element={<ProjectMembersPage />} />
              <Route path="p/:projectId/work-items" element={<WorkItemBoardPage />} />
              <Route path="p/:projectId/artifacts/:artifactId" element={<ArtifactPage />} />
              <Route path="artifacts/:artifactId" element={<ArtifactPage />} />
              <Route path="agents" element={<AgentsPage />} />
              <Route path="agents/:agentId" element={<AgentDetailPage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ApplicationErrorBoundary>
  );
}
