/**
 * Prophaze gathering template — paired with prophaze-rate-card.fixture.
 *
 * Drives the structured intake flow: a client (or rep on their behalf)
 * walks through one form whose every numeric question is bound to a
 * specific rate-card driver slug. Multi-driver-per-loop is unblocked by
 * the new `binding.serviceLineSlug` field — one "Web Application" loop
 * iteration emits five separate ScopedEntities (dynamic_pages,
 * static_pages, input_fields, roles, login_modules), each priced
 * independently against the rate card.
 *
 * Layout:
 *   1. Identity     — customer type, hosted-on-cloud flag (top-level)
 *   2. Web Apps     — loop, body nodes per driver
 *   3. APIs         — loop, body nodes per driver
 *   4. iOS Apps     — loop (separate from Android because the rate card
 *                     has slug-level platform variants)
 *   5. Android Apps — loop
 *   6. Network      — top-level numeric + binary toggles (single set
 *                     per engagement, not iterated)
 *   7. Cloud        — top-level, gated on hosted-on-cloud=yes
 *   8. Source code  — top-level, optional (gated)
 *
 * Yes/no questions reuse `single_select` with `valueMap: {yes:1,no:0}`
 * so the kernel sees a positive scope on Yes and skips on No — no new
 * node type needed.
 */

import type { NodeBinding, NodeOption, NextRule } from '@rhud/shared';

/** Stable sentinel keys — the seeder maps these to fresh UUIDs and
 *  rewrites every cross-reference inside `nextRules`. */
export const N = {
  // Identity
  CUSTOMER_TYPE:          'k_customer_type',
  CLOUD_ENABLED:          'k_cloud_enabled',
  // Web Apps loop
  LOOP_WEB:               'k_loop_web',
  WEB_DYN:                'k_web_dyn',
  WEB_STA:                'k_web_sta',
  WEB_INF:                'k_web_inf',
  WEB_ROL:                'k_web_rol',
  WEB_LOG:                'k_web_log',
  // APIs loop
  LOOP_API:               'k_loop_api',
  API_END:                'k_api_end',
  API_INF:                'k_api_inf',
  API_ROL:                'k_api_rol',
  // iOS loop
  LOOP_IOS:               'k_loop_ios',
  IOS_SCR:                'k_ios_scr',
  IOS_STA:                'k_ios_sta',
  IOS_CLS:                'k_ios_cls',
  // Android loop
  LOOP_AND:               'k_loop_and',
  AND_SCR:                'k_and_scr',
  AND_STA:                'k_and_sta',
  AND_CLS:                'k_and_cls',
  // Network (single occurrence)
  NW_SECTION:             'k_nw_section',
  NW_FW:                  'k_nw_fw',
  NW_RT:                  'k_nw_rt',
  NW_SW:                  'k_nw_sw',
  NW_EP:                  'k_nw_ep',
  NW_AV:                  'k_nw_av',
  NW_IDS:                 'k_nw_ids',
  NW_IPS:                 'k_nw_ips',
  NW_DLP:                 'k_nw_dlp',
  // Cloud (gated)
  CL_SECTION:             'k_cl_section',
  CL_INST:                'k_cl_inst',
  CL_DB:                  'k_cl_db',
  CL_IAM:                 'k_cl_iam',
  // Source code (optional)
  SRC_REVIEW_NEEDED:      'k_src_needed',
  SRC_BE_LOC:             'k_src_be',
  SRC_FE_LOC:             'k_src_fe',
} as const;

export type NodeKey = (typeof N)[keyof typeof N];

export interface FixtureNodeSpec {
  key: NodeKey;
  question: string;
  helpText?: string;
  placeholder?: string;
  required?: boolean;
  nodeType: 'single_select' | 'multi_select' | 'short_text' | 'long_text' | 'number' | 'file_upload' | 'section' | 'loop';
  options?: NodeOption[];
  allowFiles?: boolean;
  /** Each rule's `goto` is either a NodeKey (which the seeder rewrites
   *  to a UUID) or the literal 'END'. */
  nextRules: Array<{ when: NextRule['when']; goto: NodeKey | 'END' }>;
  position: number;
  parentKey?: NodeKey;
  loopConfig?: { mode: 'open_ended'; label?: string; serviceLineSlug?: string };
  binding?: NodeBinding | null;
}

const yesNoOptions: NodeOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no',  label: 'No'  },
];

const customerTypeOptions: NodeOption[] = [
  { value: 'external', label: 'External (third-party engagement)', desc: 'Most client work — black-box methodology' },
  { value: 'internal', label: 'Internal (audit of own systems)',   desc: 'Grey-box methodology with role/login deep-dive' },
];

/** Build the node spec list. Deterministic; no randomness. */
export function buildProphazeTemplateNodes(): FixtureNodeSpec[] {
  const always = (goto: NodeKey | 'END'): { when: NextRule['when']; goto: NodeKey | 'END' } => ({
    when: { op: 'always' },
    goto,
  });

  const specs: FixtureNodeSpec[] = [];
  let pos = 0;

  // ── Identity ────────────────────────────────────────────────────────
  specs.push({
    key: N.CUSTOMER_TYPE,
    question: 'Is this engagement internal (your own systems) or external (a client)?',
    helpText: 'Drives methodology auto-pick. External = Black Box, Internal = Grey Box.',
    nodeType: 'single_select',
    options: customerTypeOptions,
    nextRules: [always(N.CLOUD_ENABLED)],
    position: pos++,
    binding: { field: 'customer_type' },
  });

  specs.push({
    key: N.CLOUD_ENABLED,
    question: 'Is any part of the stack hosted on a public cloud (AWS / Azure / GCP)?',
    helpText: 'Yes = the Cloud section becomes available later in the form.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [always(N.LOOP_WEB)],
    position: pos++,
  });

  // ── Web Apps loop ───────────────────────────────────────────────────
  specs.push({
    key: N.LOOP_WEB,
    question: 'Web Applications',
    helpText: 'Add one entry per web application in scope. Skip with "No, I\'m done" if there are no web apps.',
    nodeType: 'loop',
    nextRules: [always(N.LOOP_API)],
    position: pos++,
    loopConfig: { mode: 'open_ended', label: 'Web App' },
  });
  specs.push({
    key: N.WEB_DYN,
    question: 'Number of dynamic pages in this web application',
    placeholder: 'e.g. 29',
    nodeType: 'number',
    nextRules: [always(N.WEB_STA)],
    position: 0,
    parentKey: N.LOOP_WEB,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_dynamic_pages' },
  });
  specs.push({
    key: N.WEB_STA,
    question: 'Number of static pages in this web application',
    placeholder: 'e.g. 8',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.WEB_INF)],
    position: 1,
    parentKey: N.LOOP_WEB,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_static_pages' },
  });
  specs.push({
    key: N.WEB_INF,
    question: 'Total number of input fields across the web application',
    placeholder: 'e.g. 60',
    nodeType: 'number',
    nextRules: [always(N.WEB_ROL)],
    position: 2,
    parentKey: N.LOOP_WEB,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_input_fields' },
  });
  specs.push({
    key: N.WEB_ROL,
    question: 'Number of distinct user roles (only billed for internal/grey-box)',
    placeholder: 'e.g. 5',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.WEB_LOG)],
    position: 3,
    parentKey: N.LOOP_WEB,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_roles' },
  });
  specs.push({
    key: N.WEB_LOG,
    question: 'Number of login / authentication modules (SSO providers, MFA, etc.)',
    placeholder: 'e.g. 2',
    required: false,
    nodeType: 'number',
    nextRules: [always('END')], // body END = "Add another web app?" prompt
    position: 4,
    parentKey: N.LOOP_WEB,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_login_modules' },
  });

  // ── APIs loop ───────────────────────────────────────────────────────
  specs.push({
    key: N.LOOP_API,
    question: 'APIs',
    helpText: 'Add one entry per API surface in scope (e.g. public V1, internal admin).',
    nodeType: 'loop',
    nextRules: [always(N.LOOP_IOS)],
    position: pos++,
    loopConfig: { mode: 'open_ended', label: 'API' },
  });
  specs.push({
    key: N.API_END,
    question: 'Number of endpoints in this API',
    placeholder: 'e.g. 23',
    nodeType: 'number',
    nextRules: [always(N.API_INF)],
    position: 0,
    parentKey: N.LOOP_API,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_api_endpoints' },
  });
  specs.push({
    key: N.API_INF,
    question: 'Total number of input parameters across endpoints',
    placeholder: 'e.g. 12',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.API_ROL)],
    position: 1,
    parentKey: N.LOOP_API,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_api_input_fields' },
  });
  specs.push({
    key: N.API_ROL,
    question: 'Number of distinct API roles (only billed for internal/grey-box)',
    placeholder: 'e.g. 3',
    required: false,
    nodeType: 'number',
    nextRules: [always('END')],
    position: 2,
    parentKey: N.LOOP_API,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_api_roles' },
  });

  // ── iOS loop ────────────────────────────────────────────────────────
  specs.push({
    key: N.LOOP_IOS,
    question: 'iOS Mobile Applications',
    helpText: 'Skip if no iOS apps in scope.',
    nodeType: 'loop',
    nextRules: [always(N.LOOP_AND)],
    position: pos++,
    loopConfig: { mode: 'open_ended', label: 'iOS App' },
  });
  specs.push({
    key: N.IOS_SCR,
    question: 'Number of screens in this iOS app',
    placeholder: 'e.g. 12',
    nodeType: 'number',
    nextRules: [always(N.IOS_STA)],
    position: 0,
    parentKey: N.LOOP_IOS,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_ios_screens' },
  });
  specs.push({
    key: N.IOS_STA,
    question: 'Screens covered by static analysis (often = total screens)',
    placeholder: 'e.g. 12',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.IOS_CLS)],
    position: 1,
    parentKey: N.LOOP_IOS,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_ios_static_analysis' },
  });
  specs.push({
    key: N.IOS_CLS,
    question: 'Number of classes in the codebase',
    placeholder: 'e.g. 80',
    required: false,
    nodeType: 'number',
    nextRules: [always('END')],
    position: 2,
    parentKey: N.LOOP_IOS,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_ios_classes' },
  });

  // ── Android loop ────────────────────────────────────────────────────
  specs.push({
    key: N.LOOP_AND,
    question: 'Android Mobile Applications',
    helpText: 'Skip if no Android apps in scope.',
    nodeType: 'loop',
    nextRules: [always(N.NW_SECTION)],
    position: pos++,
    loopConfig: { mode: 'open_ended', label: 'Android App' },
  });
  specs.push({
    key: N.AND_SCR,
    question: 'Number of screens in this Android app',
    placeholder: 'e.g. 12',
    nodeType: 'number',
    nextRules: [always(N.AND_STA)],
    position: 0,
    parentKey: N.LOOP_AND,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_android_screens' },
  });
  specs.push({
    key: N.AND_STA,
    question: 'Screens covered by static analysis',
    placeholder: 'e.g. 12',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.AND_CLS)],
    position: 1,
    parentKey: N.LOOP_AND,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_android_static_analysis' },
  });
  specs.push({
    key: N.AND_CLS,
    question: 'Number of classes in the codebase',
    placeholder: 'e.g. 80',
    required: false,
    nodeType: 'number',
    nextRules: [always('END')],
    position: 2,
    parentKey: N.LOOP_AND,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_mobile_android_classes' },
  });

  // ── Network (single occurrence — top-level, scope_value with slug) ──
  specs.push({
    key: N.NW_SECTION,
    question: 'Network audit scope',
    helpText: 'Counts of network appliances in scope. Leave 0 for anything not applicable. IDS/IPS/DLP are flat per-engagement.',
    nodeType: 'section',
    nextRules: [always(N.NW_FW)],
    position: pos++,
  });
  specs.push({
    key: N.NW_FW,
    question: 'Number of firewalls in scope',
    placeholder: 'e.g. 2',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.NW_RT)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_firewalls' },
  });
  specs.push({
    key: N.NW_RT,
    question: 'Number of routers in scope',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.NW_SW)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_routers' },
  });
  specs.push({
    key: N.NW_SW,
    question: 'Number of switches in scope',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.NW_EP)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_switches' },
  });
  specs.push({
    key: N.NW_EP,
    question: 'Number of endpoint devices in scope',
    helpText: 'Workstations, laptops, IoT, etc.',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.NW_AV)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_endpoints' },
  });
  specs.push({
    key: N.NW_AV,
    question: 'Number of antivirus instances in scope',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.NW_IDS)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_antivirus' },
  });
  specs.push({
    key: N.NW_IDS,
    question: 'Is an Intrusion Detection System (IDS) in scope?',
    helpText: 'Yes triggers a flat ₹10,000 fee.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [always(N.NW_IPS)],
    position: pos++,
    binding: {
      field: 'scope_value',
      serviceLineSlug: 'vapt_network_ids',
      valueMap: { yes: '1', no: '0' },
    },
  });
  specs.push({
    key: N.NW_IPS,
    question: 'Is an Intrusion Prevention System (IPS) in scope?',
    helpText: 'Yes triggers a flat ₹10,000 fee.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [always(N.NW_DLP)],
    position: pos++,
    binding: {
      field: 'scope_value',
      serviceLineSlug: 'vapt_network_ips',
      valueMap: { yes: '1', no: '0' },
    },
  });
  specs.push({
    key: N.NW_DLP,
    question: 'Is a Data Loss Prevention (DLP) system in scope?',
    helpText: 'Yes triggers a flat ₹50,000 fee.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [
      // Conditional: hop into Cloud section only when cloud_enabled was Yes
      // (the engine evaluates rules against any answer in the template, but
      // here we route everyone into CL_SECTION; the section's body skips
      // when cloud_enabled was 'no' via the section's own routing.)
      always(N.CL_SECTION),
    ],
    position: pos++,
    binding: {
      field: 'scope_value',
      serviceLineSlug: 'vapt_network_dlp',
      valueMap: { yes: '1', no: '0' },
    },
  });

  // ── Cloud (gated) ───────────────────────────────────────────────────
  // The section node's nextRules look at CLOUD_ENABLED's answer and
  // either thread into CL_INST or skip to SRC_REVIEW_NEEDED.
  specs.push({
    key: N.CL_SECTION,
    question: 'Cloud audit scope',
    helpText: 'Skipped if "Hosted on cloud" was No.',
    nodeType: 'section',
    nextRules: [always(N.CL_INST)],
    position: pos++,
  });
  specs.push({
    key: N.CL_INST,
    question: 'Number of cloud instances (EC2 / VM / equivalent)',
    placeholder: 'e.g. 12',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.CL_DB)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_cloud_instances' },
  });
  specs.push({
    key: N.CL_DB,
    question: 'Number of cloud databases (RDS / managed PostgreSQL / etc.)',
    placeholder: 'e.g. 3',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.CL_IAM)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_cloud_databases' },
  });
  specs.push({
    key: N.CL_IAM,
    question: 'Is IAM (Identity and Access Management) in scope?',
    helpText: 'Yes triggers a flat ₹30,000 fee.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [always(N.SRC_REVIEW_NEEDED)],
    position: pos++,
    binding: {
      field: 'scope_value',
      serviceLineSlug: 'vapt_cloud_iam',
      valueMap: { yes: '1', no: '0' },
    },
  });

  // ── Source code review (optional) ───────────────────────────────────
  specs.push({
    key: N.SRC_REVIEW_NEEDED,
    question: 'Is a white-box source-code review in scope?',
    helpText: 'Yes opens the LOC fields. Pricing: ₹60,000 per side for the first 1 lakh LOC, +₹10,000 per additional lakh.',
    nodeType: 'single_select',
    options: yesNoOptions,
    nextRules: [
      { when: { op: 'eq', value: 'yes' }, goto: N.SRC_BE_LOC },
      always('END'),
    ],
    position: pos++,
  });
  specs.push({
    key: N.SRC_BE_LOC,
    question: 'Backend lines of code (whole codebase)',
    placeholder: 'e.g. 250000',
    required: false,
    nodeType: 'number',
    nextRules: [always(N.SRC_FE_LOC)],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_source_code_backend' },
  });
  specs.push({
    key: N.SRC_FE_LOC,
    question: 'Frontend lines of code (whole codebase)',
    placeholder: 'e.g. 80000',
    required: false,
    nodeType: 'number',
    nextRules: [always('END')],
    position: pos++,
    binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_source_code_frontend' },
  });

  return specs;
}

export const PROPHAZE_TEMPLATE_META = {
  name: 'Prophaze — Private/Enterprise Intake',
  serviceLine: 'VAPT (multi-domain)',
};
