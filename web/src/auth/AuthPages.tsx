import { LockOutlined, MailOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { sessionQueryKey } from '../app';

const { Title, Text } = Typography;

function AuthFrame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <main className="auth-page">
      <div className="auth-brand"><RobotOutlined /><span>Agent Workspace</span></div>
      <Card className="auth-card" variant="borderless">
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
  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: (human) => {
      queryClient.setQueryData(sessionQueryKey, human);
      navigate(params.get('returnTo') || '/', { replace: true });
    },
  });
  return (
    <AuthFrame title="欢迎回来" subtitle="登录后继续进入你的 Workspace">
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
      <Text>还没有账号？<Link to="/register">创建账号</Link></Text>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: api.register,
    onSuccess: (registration) => navigate(
      `/verify-email?registrationId=${registration.registrationId}&email=${encodeURIComponent(registration.verifiedEmail)}`,
      { state: { developmentVerificationCode: registration.developmentVerificationCode } },
    ),
  });
  return (
    <AuthFrame title="创建账号" subtitle="注册后需要输入 6 位验证码确认邮箱">
      {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
      <Form layout="vertical" onFinish={(value: { displayName: string; email: string; password: string }) => mutation.mutate(value)}>
        <Form.Item name="displayName" label="显示名称" rules={[{ required: true, max: 120 }]}>
          <Input size="large" prefix={<UserOutlined />} autoComplete="name" />
        </Form.Item>
        <Form.Item name="email" label="邮箱" rules={[{ required: true }, { type: 'email' }]}>
          <Input size="large" prefix={<MailOutlined />} autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label="密码" extra="至少 10 个字符" rules={[{ required: true, min: 10, max: 128 }]}>
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={mutation.isPending}>注册并发送验证码</Button>
      </Form>
      <Text>已有账号？<Link to="/login">返回登录</Link></Text>
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
  const [developmentVerificationCode, setDevelopmentVerificationCode] = useState<string | undefined>(() => {
    const state = location.state as { developmentVerificationCode?: string } | null;
    return state?.developmentVerificationCode;
  });
  const verify = useMutation({
    mutationFn: (code: string) => api.verifyEmail({ registrationId, code }),
    onSuccess: (human) => {
      queryClient.setQueryData(sessionQueryKey, human);
      navigate('/', { replace: true });
    },
  });
  const resend = useMutation({
    mutationFn: () => api.resendVerification(registrationId),
    onSuccess: (result) => {
      setParams({ registrationId: result.registrationId, email: result.verifiedEmail });
      setDevelopmentVerificationCode(result.developmentVerificationCode);
    },
  });
  if (!registrationId) return <Navigate to="/register" replace />;
  return (
    <AuthFrame title="验证邮箱" subtitle={`验证码已发送至 ${email || '你的邮箱'}`}>
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
        <Alert type="info" showIcon title="请输入邮箱中收到的 6 位验证码。" />
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

export function InvitationAcceptPage() {
  const { invitationId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const revision = Number(params.get('revision') ?? 1);
  const mutation = useMutation({
    mutationFn: () => api.acceptInvitation(invitationId, revision),
    onSuccess: async () => {
      await message.success('已加入 Workspace');
      navigate('/', { replace: true });
    },
  });
  return (
    <main className="full-page-center page-background">
      <Card className="compact-card">
        <Space orientation="vertical" size="large">
          <Title level={3}>接受 Workspace 邀请</Title>
          <Text type="secondary">系统会验证当前账号邮箱是否与邀请目标一致。</Text>
          {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
          <Button type="primary" size="large" loading={mutation.isPending} onClick={() => mutation.mutate()}>接受邀请</Button>
        </Space>
      </Card>
    </main>
  );
}
