import { LockOutlined, MailOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Result, Space, Spin, Typography } from 'antd';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { sessionQueryKey } from '../app';
import { ThemeToggleButton } from '../theme';
import { LanguageToggleButton, useLanguage } from '../language';

const { Title, Text } = Typography;

function AuthFrame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <main className="auth-page">
      <ThemeToggleButton className="auth-theme-toggle" compact />
      <LanguageToggleButton className="auth-language-toggle" compact />
      <div className="auth-brand"><RobotOutlined /><span>SenseNova Team Harness</span></div>
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
  const { t } = useLanguage();
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
    <AuthFrame title={t('auth.welcome')} subtitle={t('auth.welcome.subtitle')}>
      {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
      <Form layout="vertical" onFinish={(value: { email: string; password: string }) => mutation.mutate(value)}>
        <Form.Item name="email" label={t('auth.email')} rules={[{ required: true }, { type: 'email' }]}>
          <Input size="large" prefix={<MailOutlined />} autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label={t('auth.password')} rules={[{ required: true, min: 10 }]}>
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={mutation.isPending}>{t('auth.login')}</Button>
      </Form>
      <Text>{t('auth.noAccount')}<Link to={returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : '/register'}>{t('auth.create')}</Link></Text>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { t } = useLanguage();
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
    <AuthFrame title={t('auth.createAccount')} subtitle={t('auth.createAccount.subtitle')}>
      {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
      <Form layout="vertical" onFinish={(value: { displayName: string; email: string; password: string }) => mutation.mutate(value)}>
        <Form.Item name="displayName" label={t('auth.displayName')} rules={[{ required: true, max: 120 }]}>
          <Input size="large" prefix={<UserOutlined />} autoComplete="name" />
        </Form.Item>
        <Form.Item name="email" label={t('auth.email')} rules={[{ required: true }, { type: 'email' }]}>
          <Input size="large" prefix={<MailOutlined />} autoComplete="email" />
        </Form.Item>
        <Form.Item name="password" label={t('auth.password')} extra={t('auth.passwordHint')} rules={[{ required: true, min: 10, max: 128 }]}>
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={mutation.isPending}>{t('auth.register')}</Button>
      </Form>
      <Text>{t('auth.hasAccount')}<Link to={returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login'}>{t('auth.backToLogin')}</Link></Text>
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const { t } = useLanguage();
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
    <AuthFrame title={t('auth.verifyEmail')} subtitle={t('auth.verifyEmail.subtitle').replace('{email}', email || t('auth.email'))}>
      {developmentVerificationCode ? (
        <Alert
          type="success"
          showIcon
          title={t('auth.devCode')}
          description={(
            <Text className="development-verification-code" copyable={{ text: developmentVerificationCode }}>
              {developmentVerificationCode}
            </Text>
          )}
        />
      ) : (
        <Alert type="info" showIcon title={t('auth.codeHint')} />
      )}
      {(verify.error || resend.error) && <Alert type="error" showIcon title={errorMessage(verify.error || resend.error)} />}
      <Form layout="vertical" onFinish={(value: { code: string }) => verify.mutate(value.code)}>
        <Form.Item name="code" label={t('auth.code')} rules={[{ required: true, pattern: /^\d{6}$/, message: t('auth.codeInvalid') }]}>
          <Input.OTP length={6} size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={verify.isPending}>{t('auth.confirmEnter')}</Button>
      </Form>
      <Button type="link" loading={resend.isPending} onClick={() => resend.mutate()}>{t('auth.resendCode')}</Button>
    </AuthFrame>
  );
}

export function WorkspaceJoinPage() {
  const { isEnglish } = useLanguage();
  const tx = (zh: string, en: string) => isEnglish ? en : zh;
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
      void message.success(tx('已加入 Workspace', 'Joined Workspace'));
      navigate(`/w/${preview.data!.workspaceId}`, { replace: true });
    },
  });

  if (preview.isPending) {
    return <div className="full-page-center page-background"><Spin size="large" /></div>;
  }
  if (preview.isError) {
    return (
      <main className="full-page-center page-background">
        <Result status="404" title={tx('邀请链接不可用', 'Invite link unavailable')} subTitle={tx('链接不存在或地址不完整，请联系 Workspace 所有者获取新的链接。', 'This link does not exist or is incomplete. Ask the Workspace owner for a new link.')} />
      </main>
    );
  }
  if (preview.data.status === 'revoked') {
    return (
      <main className="full-page-center page-background">
        <Result status="warning" title={tx('邀请链接已停用', 'Invite link deactivated')} subTitle={tx('请联系 Workspace 所有者获取新的加入链接。', 'Ask the Workspace owner for a new invite link.')} />
      </main>
    );
  }
  return (
    <main className="full-page-center page-background">
      <Card className="compact-card">
        <Space orientation="vertical" size="large">
          <Title level={3}>{tx('加入', 'Join')} {preview.data.workspaceName}</Title>
          <Text type="secondary">
            {preview.data.alreadyMember
              ? tx('你已经是这个 Workspace 的成员，可以直接进入。', 'You are already a member of this Workspace and can enter directly.')
              : tx('确认后，你会以成员身份加入这个 Workspace。链接不会向 Owner 暴露你的注册邮箱。', 'After confirmation, you will join this Workspace as a member. The link does not reveal your registration email to the Owner.')}
          </Text>
          {mutation.error && <Alert type="error" showIcon title={errorMessage(mutation.error)} />}
          {preview.data.alreadyMember ? (
            <Button type="primary" size="large" onClick={() => navigate(`/w/${preview.data.workspaceId}`, { replace: true })}>{tx('进入 Workspace', 'Enter Workspace')}</Button>
          ) : (
            <Button type="primary" size="large" loading={mutation.isPending} onClick={() => mutation.mutate()}>{tx('确认加入', 'Confirm and join')}</Button>
          )}
        </Space>
      </Card>
    </main>
  );
}
