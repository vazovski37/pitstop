import { getCurrentUser } from "./auth/session.js";
import { renderHome } from "./pages/HomePage.js";
import { renderProfile } from "./pages/ProfilePage.js";

export interface Response {
  status: number;
  body: string;
  location?: string;
}

export const html = (body: string): Response => ({ status: 200, body });
export const redirect = (location: string): Response => ({ status: 302, body: "", location });

/** Routes a request path to a page. */
export function handle(path: string): Response {
  switch (path) {
    case "/":
      return html(renderHome());
    case "/profile":
      return html(renderProfile(getCurrentUser().id));
    default:
      return { status: 404, body: "not found" };
  }
}
