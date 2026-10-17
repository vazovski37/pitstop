import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import "@fastify/cookie";
import type { RepoId } from "@pitstop/protocol";
import { ROLE_RANK, type Role, type Store, type User } from "./store.js";

/**
 * Who is calling, and what they may do (build plan, Phase 5: accounts).
 *
 * Three ways in: the shared `PITSTOP_TOKEN` (the self-host super-user, and the transition),
 * a personal token `pst_…` a daemon sends, or the session cookie a browser gets after signing
 * in with GitHub. A server with neither a shared token nor accounts is open, as on a laptop.
 */

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity;
  }
}

/** The GitHub user an OAuth code stands for. */
export interface OAuthUser {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface OAuthProvider {
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchanges the code GitHub sent back for the user behind it. */
  exchange(code: string, redirectUri: string): Promise<OAuthUser>;
}

/** GitHub's OAuth web flow with an OAuth App (client id and secret). */
export class GitHubOAuth implements OAuthProvider {
  constructor(private readonly opts: { clientId: string; clientSecret: string; fetch?: typeof fetch }) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.opts.clientId, redirect_uri: redirectUri, scope: "read:user", state });
    return `https://github.com/login/oauth/authorize?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<OAuthUser> {
    const call = this.opts.fetch ?? fetch;
    const tokenRes = await call("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code, redirect_uri: redirectUri }),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || token.access_token === undefined) {
      throw new Error(`github refused the sign-in code: ${token.error_description ?? token.error ?? tokenRes.status}`);
    }
    const userRes = await call("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "pitstop" },
    });
    if (!userRes.ok) throw new Error(`github answered ${userRes.status} to /user`);
    const u = (await userRes.json()) as { id: number; login: string; name?: string | null; avatar_url?: string | null };
    return {
      githubId: u.id,
      login: u.login,
      ...(u.name ? { name: u.name } : {}),
      ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
    };
  }
}

export type Identity = { kind: "shared" } | { kind: "user"; user: User } | { kind: "anonymous" };

export interface AuthConfig {
  /** `PITSTOP_TOKEN`: the shared super-user token. */
  sharedToken?: string;
  oauth?: OAuthProvider;
  /** Signs the cookies; accounts need it. */
  sessionSecret?: string;
  /** Where the browser goes after signing in. Default `/`. */
  webUrl?: string;
  /** `https://host` of this server for the OAuth redirect; derived from the request when absent. */
  publicUrl?: string;
  secureCookies?: boolean;
}

export const SESSION_COOKIE = "pitstop_session";
export const STATE_COOKIE = "pitstop_oauth_state";
export const SESSION_SECONDS = 30 * 24 * 3600;

export const accountsEnabled = (config: AuthConfig): boolean => config.oauth !== undefined && config.sessionSecret !== undefined;
/** No shared token and no accounts: every caller may do everything, as on a laptop. */
export const openServer = (config: AuthConfig): boolean => config.sharedToken === undefined && !accountsEnabled(config);

export const newState = (): string => randomBytes(16).toString("hex");

const sameSecret = (presented: string, expected: string): boolean =>
  presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected));

/** The bearer token a request presents: the header, or `?token=` where a browser cannot set one. */
export function presentedToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return (req.query as { token?: string } | undefined)?.token;
}

/** The value a session cookie carries. */
export const sessionValue = (user: User, now = Date.now()): string => `${user.id}:${now + SESSION_SECONDS * 1000}`;

/** Who is calling. `"bad-token"`: something was presented and it is not valid. */
export async function identify(req: FastifyRequest, store: Store, config: AuthConfig): Promise<Identity | "bad-token"> {
  const token = presentedToken(req);
  if (token !== undefined) {
    if (config.sharedToken !== undefined && sameSecret(token, config.sharedToken)) return { kind: "shared" };
    if (token.startsWith("pst_")) {
      const user = await store.userForToken(token);
      return user === undefined ? "bad-token" : { kind: "user", user };
    }
    return "bad-token";
  }
  if (accountsEnabled(config)) {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw !== undefined) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value !== null) {
        const [userId, expires] = unsigned.value.split(":");
        if (userId !== undefined && Number(expires) > Date.now()) {
          const user = await store.getUser(userId);
          if (user !== undefined) return { kind: "user", user };
        }
      }
    }
  }
  return { kind: "anonymous" };
}

/**
 * Whether the identity may act at `role` on the repository. The shared token may do anything,
 * so may everyone on an open server. A member acts at their role; a repository with no members
 * at all is open to any signed-in user (local/default, a fresh self-host); a public repository
 * can be read by anyone.
 */
export async function allowed(identity: Identity, repo: RepoId, role: Role, store: Store, config: AuthConfig): Promise<boolean> {
  if (identity.kind === "shared" || openServer(config)) return true;
  const visibility = await store.visibility(repo);
  if (visibility === undefined) return false;
  if (identity.kind === "user") {
    const own = await store.roleOf(repo, identity.user.id);
    if (own !== undefined) return ROLE_RANK[own] >= ROLE_RANK[role];
    if ((await store.listMembers(repo)).length === 0) return true;
  }
  return visibility === "public" && role === "reader";
}
