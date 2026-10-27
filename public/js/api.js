// Cliente HTTP sencillo con manejo de errores uniforme.
async function request(path, { method = 'GET', body, headers } = {}) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  let payload = null;
  if (type.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text();
  }
  if (!res.ok) {
    const message = (payload && payload.error) || (typeof payload === 'string' && payload) || `Error ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  del: (path, body) => request(path, { method: 'DELETE', body }),
};
