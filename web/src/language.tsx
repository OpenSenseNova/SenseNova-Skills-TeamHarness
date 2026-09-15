import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Language = 'zh-CN' | 'en-US';

const LANGUAGE_STORAGE_KEY = 'anc:language';
const LOCALE_STORAGE_KEY = 'anc:locale';

type LanguageContextValue = {
  language: Language;
  isEnglish: boolean;
  setLanguage: (language: Language) => void;
  toggle: () => void;
  t: (key: string, fallback?: string) => string;
};

const translations: Record<string, string> = {
  'language.zh': '中文',
  'language.en': 'English',
  'language.switchToZh': '切换为中文',
  'language.switchToEn': 'Switch to English',
  'auth.welcome': '欢迎回来',
  'auth.welcome.subtitle': '登录后回到你的协作空间',
  'auth.createAccount': '创建账号',
  'auth.createAccount.subtitle': '注册后输入 6 位验证码，立即开始协作',
  'auth.verifyEmail': '验证邮箱',
  'auth.verifyEmail.subtitle': '验证码已发送至 {email}，完成验证后即可进入 Workspace',
  'auth.email': '邮箱',
  'auth.password': '密码',
  'auth.displayName': '显示名称',
  'auth.login': '登录',
  'auth.register': '注册并发送验证码',
  'auth.noAccount': '还没有账号？',
  'auth.hasAccount': '已有账号？',
  'auth.create': '创建账号',
  'auth.backToLogin': '返回登录',
  'auth.passwordHint': '至少 10 个字符，建议混合使用字母、数字和符号',
  'auth.code': '验证码',
  'auth.codeInvalid': '请输入 6 位数字',
  'auth.confirmEnter': '确认并进入',
  'auth.resendCode': '重新发送验证码',
  'auth.devCode': '开发环境验证码',
  'auth.codeHint': '请输入邮件中的 6 位验证码；没有收到时可以重新发送。',
  'settings.title': 'Workspace 设置',
  'settings.subtitle': '管理工作区名称、成员身份和界面偏好。',
  'settings.updated': 'Workspace 名称已更新。',
  'settings.profile': '基本资料',
  'settings.workspaceName': 'Workspace 名称',
  'settings.save': '保存',
  'settings.identity': '我的成员身份',
  'settings.role': 'Workspace 角色',
  'settings.membershipId': '成员 ID',
  'settings.owner': '所有者',
  'settings.member': '成员',
  'settings.appearance': '外观',
  'settings.darkMode': '深色模式',
  'settings.language': '语言',
  'settings.danger': '危险操作',
  'settings.leaveHint': '离开后不会自动恢复原来的会话访问权；最后一名 Owner 不能离开。',
  'settings.leave': '离开 Workspace',
  'settings.leaveConfirm': '确定离开这个 Workspace？',
  'settings.leaveDescription': '此操作会移除你的成员身份。',
  'nav.collaboration': '协作',
  'nav.projects': '项目',
  'nav.team': '团队',
  'nav.workspaceSettings': 'Workspace 设置',
  'nav.logout': '退出登录',
  'entry.title': '创建你的第一个 Workspace',
  'entry.subtitle': '邀请团队成员，连接本地 Agent，把讨论、任务和交付物放在一起。',
  'entry.step1': '创建工作区', 'entry.step2': '邀请成员', 'entry.step3': '连接 Agent',
  'entry.workspaceName': 'Workspace 名称', 'entry.workspacePlaceholder': '例如：产品团队', 'entry.submit': '创建 Workspace，开始协作',
  'workspace.onboardingSteps': '开始使用的步骤',
  'workspace.ready': '已准备好', 'workspace.noConversations': '这里还没有团队会话。你可以先创建项目、邀请成员，或连接一个本地 Agent。',
  'workspace.availableAgents': '个可用 Agent', 'workspace.totalAgents': '个 Agent 总数', 'workspace.viewProjects': '查看项目', 'workspace.connectAgent': '连接本地 Agent',
  'workspace.collapse': '收起', 'workspace.expand': '展开', 'workspace.newChannel': '新建群聊', 'workspace.projectContent': '项目内容', 'workspace.loadingChannels': '加载群聊…', 'workspace.channelsError': '群聊加载失败，请稍后重试', 'workspace.unnamedChannel': '未命名群聊', 'workspace.noProjectConversations': '还没有项目会话', 'workspace.resources': '资源', 'workspace.projectMembers': '项目成员', 'workspace.workItems': '任务看板', 'workspace.projectSettings': '设置',
  'workspace.selectProject': '请先选择 Project。', 'workspace.restored': 'Conversation 已恢复', 'workspace.cannotMessageSelf': '不能与自己发起私信。',
  'workspace.backToWorkspaces': '返回 Workspace 列表', 'workspace.governanceDescription': '你当前只有 Workspace 治理信息权限：{members} 位成员，{conversations} 个会话。成员详情和内容暂不可见。', 'workspace.governanceAlert': 'Workspace 所有者只能查看治理信息，不能因此获得项目内容权限。', 'workspace.backToProjects': '返回项目列表',
  'workspace.member': '成员', 'workspace.createWorkspace': '创建 Workspace', 'workspace.switchWorkspace': '切换 Workspace', 'workspace.accountMenu': '账户菜单', 'workspace.privateChat': '私聊', 'workspace.unnamedConversation': '未命名会话',
  'workspace.agentActivity': 'Agent 实时动态', 'workspace.activityError': '动态连接异常，正在重试…', 'workspace.agentWorking': 'Agent 正在处理', 'workspace.connected': '已连接', 'workspace.offline': '离线', 'workspace.noComputer': '尚未选择计算机和本地 Agent', 'workspace.chat': '协作', 'workspace.mainNav': '主导航', 'workspace.teamConversations': '团队会话', 'workspace.noTeamConversations': '还没有团队会话', 'workspace.noDirectMessages': '从“团队”中选择成员开始私聊', 'workspace.archivedConversations': '已归档会话', 'workspace.projectCount': '项目', 'workspace.newProject': '新建项目', 'workspace.noProjects': '还没有项目，点击 + 创建一个', 'workspace.projectGovernance': '项目治理', 'workspace.governanceOnly': '仅治理信息', 'workspace.manageAgent': '管理 Agent', 'workspace.noAgents': '还没有 Agent，点击 + 创建一个', 'workspace.manageMembers': '管理成员', 'workspace.you': '你', 'workspace.basicSettings': '基本设置', 'workspace.membersAndInvites': '成员与邀请', 'workspace.openDeliverables': '打开交付物',
  'workspace.createChannelTitle': '在 {project} 中新建群聊', 'workspace.create': '创建', 'workspace.cancel': '取消', 'workspace.conversationName': '会话名称', 'workspace.conversationPlaceholder': '例如：设计评审', 'workspace.channelMembers': '群聊成员', 'workspace.channelMembersPlaceholder': '选择项目成员或你拥有的 Agent', 'workspace.channelInfo': '创建者会自动加入。Agent 需要单独加入会话，不会因为加入项目而自动出现。', 'workspace.close': '关闭', 'workspace.archivedTitle': '已归档会话', 'workspace.archivedAt': '归档于', 'workspace.archived': '已归档', 'workspace.viewHistory': '查看历史', 'workspace.restore': '恢复', 'workspace.noArchived': '没有已归档的会话', 'workspace.createProject': '创建项目', 'workspace.projectName': '项目名称', 'workspace.projectPlaceholder': '例如：agent-platform', 'workspace.descriptionOptional': '描述（可选）', 'workspace.descriptionPlaceholder': '这个项目用于什么协作？', 'workspace.projectInfo': '项目会集中管理资料、交付物和外部链接；Agent 会在隔离的临时环境中运行', 'workspace.workspaceName': 'Workspace 名称',
};

const english: Record<string, string> = {
  'language.zh': '中文', 'language.en': 'English', 'language.switchToZh': '切换为中文', 'language.switchToEn': 'Switch to English',
  'auth.welcome': 'Welcome back', 'auth.welcome.subtitle': 'Sign in to return to your workspace', 'auth.createAccount': 'Create account', 'auth.createAccount.subtitle': 'Enter the 6-digit code after registration to start collaborating', 'auth.verifyEmail': 'Verify email',
  'auth.email': 'Email', 'auth.password': 'Password', 'auth.displayName': 'Display name', 'auth.login': 'Sign in', 'auth.register': 'Register and send code', 'auth.noAccount': "Don't have an account?", 'auth.hasAccount': 'Already have an account?', 'auth.create': 'Create account', 'auth.backToLogin': 'Back to sign in', 'auth.passwordHint': 'At least 10 characters; a mix of letters, numbers, and symbols is recommended', 'auth.code': 'Verification code', 'auth.codeInvalid': 'Enter 6 digits', 'auth.confirmEnter': 'Confirm and enter', 'auth.resendCode': 'Resend code', 'auth.devCode': 'Development verification code', 'auth.codeHint': 'Enter the 6-digit code from your email. You can resend it if you did not receive it.', 'auth.verifyEmail.subtitle': 'A verification code was sent to {email}. Verify it to enter your Workspace.',
  'settings.title': 'Workspace settings', 'settings.updated': 'Workspace name updated.', 'settings.subtitle': 'Manage the workspace name, membership, and interface preferences.', 'settings.profile': 'Basic information', 'settings.workspaceName': 'Workspace name', 'settings.save': 'Save', 'settings.identity': 'My membership', 'settings.role': 'Workspace role', 'settings.membershipId': 'Membership ID', 'settings.owner': 'Owner', 'settings.member': 'Member', 'settings.appearance': 'Appearance', 'settings.darkMode': 'Dark mode', 'settings.language': 'Language', 'settings.danger': 'Danger zone', 'settings.leaveHint': 'Leaving does not restore your previous conversation access; the last Owner cannot leave.', 'settings.leave': 'Leave Workspace', 'settings.leaveConfirm': 'Leave this Workspace?', 'settings.leaveDescription': 'This will remove your membership.',
  'nav.collaboration': 'Collaboration', 'nav.projects': 'Projects', 'nav.team': 'Team', 'nav.workspaceSettings': 'Workspace settings', 'nav.logout': 'Sign out',
  'entry.title': 'Create your first Workspace', 'entry.subtitle': 'Invite teammates, connect local Agents, and keep conversations, tasks, and deliverables together.', 'entry.step1': 'Create workspace', 'entry.step2': 'Invite members', 'entry.step3': 'Connect Agent', 'entry.workspaceName': 'Workspace name', 'entry.workspacePlaceholder': 'For example: Product team', 'entry.submit': 'Create Workspace and start collaborating',
  'workspace.onboardingSteps': 'Getting started steps', 'workspace.ready': 'is ready', 'workspace.noConversations': 'There are no team conversations yet. Create a project, invite members, or connect a local Agent to get started.', 'workspace.availableAgents': 'available Agents', 'workspace.totalAgents': 'Agents total', 'workspace.viewProjects': 'View projects', 'workspace.connectAgent': 'Connect local Agent', 'workspace.collapse': 'Collapse', 'workspace.expand': 'Expand', 'workspace.newChannel': 'New group chat', 'workspace.projectContent': 'Project content', 'workspace.loadingChannels': 'Loading group chats…', 'workspace.channelsError': 'Failed to load group chats. Please try again.', 'workspace.unnamedChannel': 'Untitled group chat', 'workspace.noProjectConversations': 'No project conversations yet', 'workspace.resources': 'Resources', 'workspace.projectMembers': 'Project members', 'workspace.workItems': 'Task board', 'workspace.projectSettings': 'Settings', 'workspace.selectProject': 'Please select a Project first.', 'workspace.restored': 'Conversation restored', 'workspace.cannotMessageSelf': 'You cannot start a direct message with yourself.', 'workspace.backToWorkspaces': 'Back to Workspace list', 'workspace.governanceDescription': 'You only have Workspace governance access: {members} members and {conversations} conversations. Member details and content are unavailable.', 'workspace.governanceAlert': 'Workspace owners can view governance information only; this does not grant access to project content.', 'workspace.backToProjects': 'Back to project list', 'workspace.member': 'Member', 'workspace.createWorkspace': 'Create Workspace', 'workspace.switchWorkspace': 'Switch Workspace', 'workspace.accountMenu': 'Account menu', 'workspace.privateChat': 'Direct message', 'workspace.unnamedConversation': 'Untitled conversation', 'workspace.agentActivity': 'Agent activity', 'workspace.activityError': 'Activity connection failed, retrying…', 'workspace.agentWorking': 'Agent is working', 'workspace.connected': 'Connected', 'workspace.offline': 'Offline', 'workspace.noComputer': 'No computer or local Agent selected', 'workspace.chat': 'Collaboration', 'workspace.mainNav': 'Main navigation', 'workspace.teamConversations': 'Team conversations', 'workspace.noTeamConversations': 'No team conversations yet', 'workspace.noDirectMessages': 'Select a member from “Team” to start a direct message', 'workspace.archivedConversations': 'Archived conversations', 'workspace.projectCount': 'Projects', 'workspace.newProject': 'New project', 'workspace.noProjects': 'No projects yet. Click + to create one', 'workspace.projectGovernance': 'Project governance', 'workspace.governanceOnly': 'governance only', 'workspace.manageAgent': 'Manage Agents', 'workspace.noAgents': 'No Agents yet. Click + to create one', 'workspace.manageMembers': 'Manage members', 'workspace.you': 'You', 'workspace.basicSettings': 'Basic settings', 'workspace.membersAndInvites': 'Members and invites', 'workspace.openDeliverables': 'Open deliverables', 'workspace.createChannelTitle': 'New group chat in {project}', 'workspace.create': 'Create', 'workspace.cancel': 'Cancel', 'workspace.conversationName': 'Conversation name', 'workspace.conversationPlaceholder': 'For example: design review', 'workspace.channelMembers': 'Group chat members', 'workspace.channelMembersPlaceholder': 'Select project members or Agents you own', 'workspace.channelInfo': 'The creator joins automatically. Agents must be added separately and do not appear automatically when added to a project.', 'workspace.close': 'Close', 'workspace.archivedTitle': 'Archived conversations', 'workspace.archivedAt': 'Archived on', 'workspace.archived': 'Archived', 'workspace.viewHistory': 'View history', 'workspace.restore': 'Restore', 'workspace.noArchived': 'No archived conversations', 'workspace.createProject': 'Create project', 'workspace.projectName': 'Project name', 'workspace.projectPlaceholder': 'For example: agent-platform', 'workspace.descriptionOptional': 'Description (optional)', 'workspace.descriptionPlaceholder': 'What is this project for?', 'workspace.projectInfo': 'Projects centralize materials, deliverables, and external links; Agents run in isolated temporary environments.', 'workspace.workspaceName': 'Workspace name',
};

const defaultLanguage: LanguageContextValue = {
  language: 'zh-CN',
  isEnglish: false,
  setLanguage: () => undefined,
  toggle: () => undefined,
  t: (key, fallback) => translations[key] ?? fallback ?? key,
};
const LanguageContext = createContext<LanguageContextValue>(defaultLanguage);

function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en-US') return stored;
  } catch { /* Use the default language when storage is unavailable. */ }
  return 'zh-CN';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, language);
    } catch { /* Session-only preference. */ }
  }, [language]);
  const value = useMemo<LanguageContextValue>(() => ({
    language,
    isEnglish: language === 'en-US',
    setLanguage,
    toggle: () => setLanguage((current) => current === 'en-US' ? 'zh-CN' : 'en-US'),
    t: (key, fallback) => (language === 'en-US' ? english[key] : translations[key]) ?? fallback ?? key,
  }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}

/**
 * System-generated default conversation names. The backend creates these in
 * Chinese and stores them verbatim, so they are localized only for display —
 * user-renamed conversations keep their own title.
 */
const DEFAULT_CONVERSATION_NAMES: Record<string, string> = {
  '全员大群': 'All-hands',
  '主群': 'Main channel',
};

/** Localize a default conversation name for display; leaves custom titles unchanged. */
export function localizeConversationName(name: string | null | undefined, isEnglish: boolean): string | null {
  if (!name) return name ?? null;
  if (isEnglish && DEFAULT_CONVERSATION_NAMES[name]) return DEFAULT_CONVERSATION_NAMES[name];
  return name;
}

export function LanguageToggleButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { isEnglish, toggle, t } = useLanguage();
  const label = isEnglish ? t('language.switchToZh') : t('language.switchToEn');
  return (
    <button type="button" className={className ? `language-toggle ${className}` : 'language-toggle'} onClick={toggle} aria-label={label} title={label}>
      {compact ? (isEnglish ? '中' : 'EN') : `${isEnglish ? '中' : 'EN'} · ${isEnglish ? t('language.zh') : t('language.en')}`}
    </button>
  );
}
