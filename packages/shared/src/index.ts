export function hasAdminRole(role: string | null | undefined): boolean {
  return role?.split(',').includes('admin') ?? false;
}

export function parseAdminUsernames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
