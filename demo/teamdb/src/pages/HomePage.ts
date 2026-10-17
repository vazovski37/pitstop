import { getCurrentUser } from "../auth/session.js";

export function renderHome(): string {
  const user = getCurrentUser();
  return `<h1>Welcome back, ${user.name}</h1>`;
}
