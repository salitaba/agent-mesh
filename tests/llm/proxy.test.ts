/**
 * The way out of a workspace, for the model port.
 *
 * A workspace container resolves nothing itself: the egress proxy is the only way out, and a call that skips it dies
 * with `getaddrinfo EAI_AGAIN`. Node's `NODE_USE_ENV_PROXY` covers that for a plain process in the live container
 * (measured: 200), but not for the mesh's own call (measured: the same EAI_AGAIN, and the egress proxy logged no tunnel
 * for it), so the port installs its own dispatcher when the environment names a proxy. What is tested here is the
 * decision and the install-once discipline, not the network: the dispatcher's behaviour is measured against the live
 * host and is not something a fixture can stand in for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici";
import { installProxyDispatcher, proxyFromEnv, providerFetch, resetProxyDispatcher } from "../../packages/llm/src/index";

test("the proxy the environment names: https first, an empty name is no name", () => {
  assert.equal(proxyFromEnv({}), undefined, "no proxy named");
  assert.equal(proxyFromEnv({ http_proxy: "   " }), undefined, "a proxy that is only whitespace is not a proxy");
  assert.equal(proxyFromEnv({ http_proxy: "http://10.213.0.1:3128/" }), "http://10.213.0.1:3128/");
  assert.equal(
    proxyFromEnv({ http_proxy: "http://plain:1", https_proxy: "http://secure:2" }),
    "http://secure:2",
    "https_proxy wins: the model call is https, and a workspace's egress proxy is the same address either way",
  );
});

test("with no proxy named, the port's fetch is the platform's own and nothing is installed", () => {
  resetProxyDispatcher();
  const before = getGlobalDispatcher();
  const used = providerFetch({});
  assert.equal(getGlobalDispatcher(), before, "an environment that names no proxy must not have a dispatcher installed for it");
  assert.equal(typeof used, "function");
});

test("with a proxy named, the dispatcher is installed once, and the first proxy the process saw is the one it uses", () => {
  resetProxyDispatcher();
  const before = getGlobalDispatcher();
  assert.equal(installProxyDispatcher({ https_proxy: "http://10.213.0.1:3128/" }), true);
  const after = getGlobalDispatcher();
  assert.notEqual(after, before, "the environment names a proxy, so the default dispatcher is no longer what a call goes through");
  assert.equal(installProxyDispatcher({ https_proxy: "http://another:1" }), true);
  assert.equal(getGlobalDispatcher(), after, "installed once per process, not once per call");
});

test("the port's proxied fetch is a function that can be handed to the transport", () => {
  resetProxyDispatcher();
  const used = providerFetch({ https_proxy: "http://10.213.0.1:3128/" });
  assert.equal(typeof used, "function");
});
