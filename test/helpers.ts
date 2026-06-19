/** 테스트 헬퍼: fetch 모킹. */

export interface MockResponse {
  status: number;
  body: unknown;
}

type Handler = (url: string, init: RequestInit) => MockResponse;

/** url/init를 받아 MockResponse를 돌려주는 핸들러로 동작하는 fetch 함수를 만든다. */
export function mockFetch(handler: Handler): typeof fetch {
  const fn = async (input: any, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return fn as unknown as typeof fetch;
}
