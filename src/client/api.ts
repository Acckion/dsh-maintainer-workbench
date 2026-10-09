export const API = "/maintainer/api";
export async function request(path: string, data?: unknown) {
  const response = await fetch(
    API + path,
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "请求失败"), { status: response.status, code: result.code });
  return result;
}
