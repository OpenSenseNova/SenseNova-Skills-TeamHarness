import { LockOutlined, MailOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Result, Space, Spin, Typography } from 'antd';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { sessionQueryKey } from '../app';
import { ThemeToggleButton } from '../theme';

const { Title, Text } = Typography;

function AuthFrame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <main className="auth-page">
      <ThemeToggleButton className="auth-theme-toggle" compact />
      <div className="auth-brand"><RobotOutlined /><span>AI Native Collaboration</span></div>
      <Card className="auth-card" variant="borderless">
        <Text className="auth-kicker">HUMAN + LOCAL AGENT</Text>
        <Title level={2}>{title}</Title>
        <Text type="secondary">{subtitle}</Text>
        <div className="auth-form">{children}</div>
      </Card>
    </main>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const returnTo = params.get('returnTo') || '';
  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: (human) => {
      queryClient.setQueryData(sessionQueryKey, human);
      navigate(returnTo || '/', { replace: true });
    },
  });
  return (
    <AuthFrame title="欢迎回来" subtitle="登录后回到你的协作空间">
      {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
      <Form layout="vertical" onFinish={(value: { email: string; password: string }) => mutation.mutate(value)}>
        <Form.Item name="email" label="邮箱" rules={[{ required: true }, { type: 'email' }]}>
          <Input size="large" prefix={<MailOutlined />} autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, min: 10 }]}>
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={mutation.isPending}>登录</Button>
      </Form>
      <Text>还没有账号？<Link to={returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register'}>创建账号</Link></Text>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = params.get('returnTo') || '';
  const mutation = useMutation({
    mutationFn: api.register,
    onSuccess: (registration) => navigate(
      `/verify-email?registrationId=${registration.registrationId}&email=${encodeURIComponent(registration.verifiedEmail)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ''}`,
      { state: { developmentVerificationCode: registration.developmentVerificationCode } },
    ),
  });
  return (
    <AuthFrame title="创建账号" subtitle="注册后输入 6 位验证码，立即开始协作">
      {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
      <Form layout="vertical" onFinish={(value: { displayName: string; email: string; password: string }) => mutation.mutate(value)}>
        <Form.Item name="displayName" label="显示名称" rules={[{ required: true, max: 120 }]}>
          <Input size="large" prefix={<UserOutlined />} autoComplete="name" />
        </Form.Item>
        <Form.Item name="email" label="邮箱" rules={[{ required: true }, { type: 'email' }]}>
          <Input size="large" prefix={<MailOutlined />} autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" extra="至少 10 个字符，建议混合使用字母、数字和符号" rules={[{ required: true, min: 10, max: 128 }]}>
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={mutation.isPending}>注册并发送验证码</Button>
      </Form>
      <Text>已有账号？<Link to={returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login'}>返回登录</Link></Text>
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const registrationId = params.get('registrationId') ?? '';
  const email = params.get('email') ?? '';
  const returnTo = params.get('returnTo') ?? '';
  const [developmentVerificationCode, setDevelopmentVerificationCode] = useState<string | undefined>(() => {
    const state = location.state as { developmentVerificationCode?: string } | null;
    return state?.developmentVerificationCode;
  });
  const verify = useMutation({
    mutationFn: (code: string) => api.verifyEmail({ registrationId, code }),
    onSuccess: (human) => {
      queryClient.setQueryData(sessionQueryKey, human);
      navigate(returnTo || '/', { replace: true });
    },
  });
  const resend = useMutation({
    mutationFn: () => api.resendVerification(registrationId),
    onSuccess: (result) => {
      setParams({
        registrationId: result.registrationId,
        email: result.verifiedEmail,
        ...(returnTo ? { returnTo } : {}),
      });
      setDevelopmentVerificationCode(result.developmentVerificationCode);
    },
  });
  if (!registrationId) return <Navigate to="/register" replace />;
  return (
    <AuthFrame title="验证邮箱" subtitle={`验证码已发送至 ${email || '你的邮箱'}，完成验证后即可进入 Workspace`}>
      {developmentVerificationCode ? (
        <Alert
          type="success"
          showIcon
          title="开发环境验证码"
          description={(
            <Text className="development-verification-code" copyable={{ text: developmentVerificationCode }}>
              {developmentVerificationCode}
            </Text>
          )}
        />
      ) : (
        <Alert type="info" showIcon title="请输入邮件中的 6 位验证码；没有收到时可以重新发送。" />
      )}
      {(verify.error || resend.error) && <Alert type="error" showIcon title={errorMessage(verify.error || resend.error)} />}
      <Form layout="vertical" onFinish={(value: { code: string }) => verify.mutate(value.code)}>
        <Form.Item name="code" label="验证码" rules={[{ required: true, pattern: /^\d{6}$/, message: '请输入 6 位数字' }]}>
          <Input.OTP length={6} size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={verify.isPending}>确认并进入</Button>
      </Form>
      <Button type="link" loading={resend.isPending} onClick={() => resend.mutate()}>重新发送验证码</Button>
    </AuthFrame>
  );
}

export function WorkspaceJoinPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const preview = useQuery({
    queryKey: ['workspace-join-link', token],
    queryFn: () => api.previewWorkspaceJoinLink(token),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () => api.acceptWorkspaceJoinLink(token),
    onSuccess: () => {
      void message.success('已加入 Workspace');
      navigate(`/w/${preview.data!.workspaceId}`, { replace: true });
    },
  });

  if (preview.isPending) {
    return <div className="full-page-center page-background"><Spin size="large" /></div>;
  }
  if (preview.isError) {
    return (
      <main className="full-page-center page-background">
        <Result status="404" title="邀请链接不可用" subTitle="链接不存在或地址不完整，请联系 Workspace 所有者获取新的链接。" />
      </main>
    );
  }
  if (preview.data.status === 'revoked') {
    return (
      <main className="full-page-center page-background">
        <Result status="warning" title="邀请链接已停用" subTitle="请联系 Workspace 所有者获取新的加入链接。" />
      </main>
    );
  }
  return (
    <main className="full-page-center page-background">
      <Card className="compact-card">
        <Space orientation="vertical" size="large">
          <Title level={3}>加入 {preview.data.workspaceName}</Title>
          <Text type="secondary">
            {preview.data.alreadyMember
              ? '你已经是这个 Workspace 的成员，可以直接进入。'
              : '确认后，你会以成员身份加入这个 Workspace。链接不会向 Owner 暴露你的注册邮箱。'}
          </Text>
          {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
          {preview.data.alreadyMember ? (
            <Button type="primary" size="large" onClick={() => navigate(`/w/${preview.data.workspaceId}`, { replace: true })}>进入 Workspace</Button>
          ) : (
            <Button type="primary" size="large" loading={mutation.isPending} onClick={() => mutation.mutate()}>确认加入</Button>
          )}
        </Space>
      </Card>
    </main>
  );
}
