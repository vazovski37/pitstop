export interface User {
  id: string;
  name: string;
  email: string;
}

// In TeamDB these are database rows; the slice keeps a list.
const users: User[] = [
  { id: "u1", name: "Nino", email: "nino@teamdb.example" },
  { id: "u2", name: "Giorgi", email: "giorgi@teamdb.example" },
];

/** A user by id, or undefined when there is none. */
export function findUser(id: string): User | undefined {
  return users.find((u) => u.id === id);
}
