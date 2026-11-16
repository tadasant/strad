/**
 * Names a deposit may never create, on any slug: the ones a process reads as
 * an instruction rather than as a credential. A `params: true` server loads
 * its whole `static/` namespace into its environment, so `NODE_OPTIONS` there
 * is code execution and `HTTPS_PROXY` is every request it makes, read by
 * someone else. A list rather than a rule, so it errs by refusing.
 *
 * Shared by the route (src/http/deposit.ts), which refuses the name at write
 * time, and the config schema, which refuses a `deposit.paramsVariables:`
 * entry that names one — an allowlist entry the route would refuse anyway is
 * a config that says something it does not do.
 */
export const DEPOSIT_PROCESS_CONTROL =
  /^(NODE_|LD_|DYLD_|STRAD_|OTEL_|NPM_CONFIG_|GIT_|PYTHON|SSL_|SENTRY_|GOOGLE_APPLICATION_CREDENTIALS$|(HTTPS?|ALL|NO)_PROXY$|(PATH|HOME|SHELL|TMPDIR|PORT|HOST|TZ|LANG|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$)/i;
