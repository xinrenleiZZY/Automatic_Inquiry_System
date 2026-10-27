export interface UserInfo {
  id: number | null;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  roles: string[];
}

export interface Job {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  progress?: { step?: number; text?: string; at?: number } | null;
  result?: unknown;
  error?: string | null;
  created_by?: string | null;
  created_at?: number;
  started_at?: number;
  finished_at?: number;
  payload?: Record<string, unknown>;
}

export interface AiCallTrace {
  id: number;
  request_id: string;
  epoch: number;
  finished_at?: number | null;
  elapsed_ms?: number | null;
  source: string;
  endpoint?: string | null;
  model?: string | null;
  status: string;
  http_status?: number | null;
  attempts?: number | null;
  campaign_id?: number | null;
  conv_key?: string | null;
  job_id?: string | null;
  request_chars?: number | null;
  request_hash?: string | null;
  request_json?: string | null;
  response_text?: string | null;
  response_content?: string | null;
  usage_json?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  error?: string | null;
  meta_json?: string | null;
}

export interface FlowStep {
  id: string;
  flow_id: string;
  campaign_id: number;
  step_no: number;
  kind: string;
  payload?: Record<string, unknown>;
  status: string;
  run_after?: number;
  attempts?: number;
  error?: string | null;
  created_at?: number;
  updated_at?: number;
  jobs?: Job[];
}

export interface FlowRun {
  id: string;
  campaign_id: number;
  status: string;
  payload?: Record<string, unknown>;
  created_at?: number;
  updated_at?: number;
  campaign_name?: string;
  campaign_status?: string;
  campaign_stage?: string;
  total_steps?: number;
  done_steps?: number;
  failed_steps?: number;
  current_kind?: string | null;
  current_step_no?: number | null;
}

export interface Counts {
  conversations: number;
  messages: number;
  events: number;
  campaigns: number;
  image_contacts: number;
  phrase_sends: number;
  supplier_quotes: number;
  offer_prices: number;
  auto_replies: number;
  image_library: number;
  phrase_library: number;
}

export interface CompareRow {
  id: number;
  campaign_id?: number | null;
  campaign_name?: string | null;
  conv_key?: string | null;
  supplier_wangwang?: string | null;
  product_image?: string | null;
  phrase?: string | null;
  page_price?: string | null;
  page_price_num?: number | null;
  raw_text?: string | null;
  unit_price?: string | null;
  unit_price_final?: number | null;
  price_basis?: string | null;
  diff?: number | null;
  diff_pct?: number | null;
  verdict?: string;
  meets_target?: boolean | null;
  moq?: string | null;
  freight?: string | null;
  sample_lead_time?: string | null;
  bulk_lead_time?: string | null;
  sample_fee_refundable?: string | null;
  price_incl_sample_fee?: string | null;
  defect_rate?: string | null;
  nda?: string | null;
  remark?: string | null;
  status?: string | null;
  is_dropped?: boolean;
  is_need_human?: boolean;
  is_give_up?: boolean;
  not_doing_reason?: string | null;
  handoff_contact?: string | null;
  updated_at?: number | null;
  summary_fields?: {
    moq?: string;
    freight?: string;
    sample_lead_time?: string;
    bulk_lead_time?: string;
    sample_fee_refundable?: string;
    price_incl_sample_fee?: string;
    defect_rate?: string;
    nda?: string;
  };
}

export interface Campaign {
  id: number;
  name: string;
  image_file?: string | null;
  image_id?: string | null;
  phrase_id?: string | null;
  phrase_text?: string | null;
  status?: string | null;
  stage?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  note?: string | null;
  contact_count?: number;
  quote_count?: number;
  priced_count?: number;
  offer_count?: number;
  contacts?: Array<Record<string, unknown>>;
  quotes?: Array<Record<string, unknown>>;
  offers?: Array<Record<string, unknown>>;
  /** 本任务显式覆盖的业务参数（留空的字段不会出现在这里） */
  params_override?: Record<string, unknown>;
  /** 真正生效的业务参数 = 全局默认 ← 本任务覆盖 */
  params_effective?: Record<string, unknown>;
  params_customized?: boolean;
  template_id?: number | null;
}

export interface PricingTemplate {
  id: number;
  name: string;
  description?: string;
  send_mode: 'send' | 'draft' | 'dry';
  inquiry_count: number;
  slice_per_round: number;
  expected_price?: number | null;
  expected_price_note?: string;
  max_followups: number;
  duration_sec: number;
  reply_timeout_sec: number;
  created_by?: string;
  created_at?: number;
  updated_at?: number;
}

export interface Customer {
  conv_key: string;
  name: string;
  peer?: string | null;
  is_self?: boolean;
  msg_count?: number;
  in_count?: number;
  out_count?: number;
  last_text?: string | null;
  last_at?: number | null;
  quote_count?: number;
  best_price?: number | null;
  last_price?: number | null;
  phrase_ids?: string | null;
  image_ids?: string | null;
  campaign_ids?: string | null;
  list_type?: string | null;
  flag_note?: string | null;
  /** 名单的适用范围：0 = 全部任务；>0 = 只对该任务生效 */
  flag_scope?: number | null;
  quote_status?: string | null;
  task_state?: string | null;
  task_decision?: string | null;
  result_status?: 'waiting' | 'complete' | 'dropped' | 'needs_human' | 'give_up';
  result_label?: string;
  result_reason?: string;
  result_detail?: string;
}

export interface ChatMessage {
  id: number;
  direction: 'in' | 'out';
  sender?: string | null;
  text?: string | null;
  image_url?: string | null;
  ui_time?: string | null;
  msg_epoch?: number | null;
  captured_at?: number | null;
}

export interface Phrase {
  id: string;
  name: string;
  text: string;
  image: string;
    /** 产品关键词：搜图后在 1688「结果中搜索」里再筛一次 */
    keyword?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface LibraryImage {
  path: string;
  fileName: string;
  base: string;
  size: number;
  hash: string;
  phrase_id?: string | null;
  status?: string | null;
  image_id?: string | null;
  last_run_at?: number | null;
  note?: string | null;
}

export interface Settings {
  send_mode: string;
  inquiry_count: number;
  max_inquiry_count: number;
  expected_price: number | null;
  expected_price_note: string;
  slice_per_round: number;
  min_interval_ms: number;
  max_per_hour: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  auto_refresh_min: number;
  scheduler_round_sec: number;
  /** 调试实例用的 chrome.exe 路径（"" = 自动检测；在「状态监控」页修改） */
  chrome_exe?: string;
}

export interface ListFlag {
  conv_key: string;
  conv_name?: string | null;
  list_type: 'whitelist' | 'blacklist' | 'dropped';
  note?: string | null;
  updated_at?: number;
  /** 适用范围：0 = 全部任务；>0 = 只对该任务生效 */
  campaign_id?: number;
  /** 带 campaign_id 查询时：这条是否是当前生效的那条（任务级覆盖全局级） */
  effective?: boolean;
}

export interface Flows {
  monitor: {
    pid: number | null;
    alive: boolean;
    log_tail: string[];
    interval_sec: number;
    refresh_min: number;
  };
  queue: {
    running: boolean;
    paused: boolean;
    depth: number;
    current: { id: string; type: string; started_at: number } | null;
    processed: number;
    failed: number;
  };
  bridge: { running: boolean; pid: number | null; calls: number; restarts: number; last_error?: string | null };
}

/* ------------------------- 状态监控（1688 浏览器 / 登录态） ------------------------- */

export type CheckLevel = 'ok' | 'warn' | 'bad' | 'idle';

/** 一条检测项：判定与文案都由后端算好，前端只负责显示 */
export interface BrowserCheck {
  key: string;
  label: string;
  ok: boolean;
  level: CheckLevel;
  detail: string;
}

export interface BrowserTab {
  id: string;
  kind: 'chat' | 'search' | 'results' | 'other';
  kind_cn: string;
  title: string;
  url: string;
  imageId?: string;
  chatUid?: string;
  is_login_page?: boolean;
}

export interface BrowserLogin {
  logged_in?: boolean;
  validity?: string;
  account?: string;
  member_id?: string;
  cookie_count?: number;
  markers?: string[];
  weak_markers?: string[];
  login_page_tabs?: number;
  nearest_expiry?: number | null;
  reason?: string;
  cookie_login?: boolean;
  server?: {
    ok?: boolean;
    logged_in?: boolean;
    status?: number;
    final_url?: string;
    checked_url?: string;
    login_redirect?: boolean;
    error?: string;
    cached?: boolean;
    elapsed_ms?: number;
  };
  items?: Array<{ name: string; domain: string; expires: number; session: boolean }>;
}

export interface BrowserVerdict {
  state?: string;
  ok?: boolean;
  label?: string;
  reason?: string;
}

export interface BrowserStatus {
  at: number | null;
  overall: { ok: boolean; label: string; reason: string; failed: string[]; warnings: string[] };
  checks: BrowserCheck[];
  cdp: { reachable?: boolean; base?: string; browser?: string; protocol?: string; error?: string | null };
  login: BrowserLogin;
  verdict: BrowserVerdict;
  pages: BrowserTab[];
  counts: Record<string, number>;
  chat?: Record<string, unknown> | null;
  /** 登录页当前状态（自动滑块失败或等待短信验证码时，这里说明卡在哪一步） */
  login_page?: BrowserLoginPageState | null;
  chat_note?: string | null;
  probe_error?: string | null;
  chrome?: {
    ok?: boolean;
    action?: string;
    error?: string | null;
    note?: string | null;
    launched?: boolean;
    killed?: number[];
    profileDir?: string;
    debugChrome?: { count?: number; mainPid?: number | null; pids?: number[]; startedAt?: string | null };
  };
  /** chrome.exe 路径：页面设置 / 环境变量 / 自动检测 */
  chrome_path?: BrowserChromePath;
  monitor: Flows['monitor'];
  queue: Flows['queue'];
  target: {
    cdp_base: string;
    cdp_port: number;
    profile_dir: string;
    start_url: string;
    control_script: string;
    control_script_exists: boolean;
  };
}

export interface BrowserChromePath {
  /** 页面里保存的值（空 = 没设过） */
  configured: string;
  /** setting = 页面设置，env = 环境变量 CHROME_EXE，auto = 自动检测 */
  source: 'setting' | 'env' | 'auto';
  source_cn: string;
  /** 实际会用的那个路径 */
  resolved: string;
  exists: boolean;
  candidates: string[];
  profile_dir: string;
  env_value: string;
  error?: string | null;
}

/** 登录页当前状态（「立即体检」时读一次，用于说明卡在哪一步） */
export interface BrowserLoginPageState {
  target_id?: string;
  url?: string;
  user_filled?: boolean;
  pass_filled?: boolean;
  user_value?: string;
  submit_visible?: boolean;
  slider_visible?: boolean;
  risk_verify?: boolean;
  sms_visible?: boolean;
  keep_visible?: boolean;
  error_text?: string;
  hint?: string;
  error?: string;
  verdict?: { state: string; detail: string };
}

/** 1688 登录凭证：密码只回"有没有存"，永不回显 */
export interface BrowserLoginInfo {
  account: string;
  has_password: boolean;
  note: string;
}

export interface BrowserStep {
  step: string;
  ok: boolean;
  detail: string;
}
