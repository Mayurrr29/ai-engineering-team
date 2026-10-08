/** The only user fields that may leave the API. Never return a raw user document. */
export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
