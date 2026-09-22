const store = [
  { id: 1, name: "Alice", role: "admin" },
  { id: 2, name: "Bob",   role: "member" },
  { id: 3, name: "Carol", role: "member" },
  { id: 4, name: "Dave",  role: "guest" },
];

// TODO: extend to accept an optional `role` filter argument.
export function getUsers() {
  return store.slice();
}
