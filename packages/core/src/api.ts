import { requireToken } from "./auth.ts";
import { boolean, CliError, invalidResponse, object, optionalString, requiredString } from "./errors.ts";
import { searchFoodsResponse } from "./foods.ts";
import type { FoodSuggestionRequest } from "./suggestions.ts";

const FITIA = "https://app.fitia.app";
const ACCOUNT = "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyDuydfUsIFGRZttSiB3mEy0yBwAnnAa2yA";
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class FitiaClient {
  constructor(
    private token?: string,
    private timeoutMs = 15000,
    private fetcher: Fetch = fetch,
  ) {}

  private async request(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403 || (url === ACCOUNT && response.status === 400)) {
          throw new CliError(
            "AUTH_REJECTED",
            "The service rejected the credentials or access.",
            "Supply a fresh Fitia ID token for your own account.",
            3,
          );
        }
        if (response.status === 429)
          throw new CliError(
            "RATE_LIMITED",
            "Fitia is limiting requests.",
            "Wait before retrying. No automatic retries were made.",
            4,
          );
        throw new CliError(
          "HTTP_ERROR",
          `The service returned HTTP ${response.status}.`,
          "Retry later or inspect the API contract if the error persists.",
          4,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) invalidResponse();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          invalidResponse();
        }
        chunks.push(value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        invalidResponse();
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      const name = error instanceof Error ? error.name : "";
      throw new CliError(
        name === "TimeoutError" || name === "AbortError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        "Could not complete the service request.",
        "Check your connection and retry. Credentials and upstream errors are not printed.",
        4,
      );
    }
  }

  private get(path: string) {
    return this.request(`${FITIA}${path}`, {
      headers: { Authorization: requireToken(this.token), Accept: "application/json" },
      cache: "no-store",
    });
  }

  async account() {
    const response = object(
      await this.request(ACCOUNT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: requireToken(this.token) }),
      }),
    );
    if (!Array.isArray(response.users) || response.users.length !== 1) invalidResponse();
    const user = object(response.users[0]);
    const providers = user.providerUserInfo ?? [];
    if (!Array.isArray(providers)) invalidResponse();
    return {
      id: requiredString(user.localId),
      email: optionalString(user.email),
      name: optionalString(user.displayName),
      emailVerified: boolean(user.emailVerified),
      providers: providers.map((p) => requiredString(object(p).providerId)),
    };
  }

  async profile() {
    // Only a server verified identity may select the profile path.
    const account = await this.account();
    const data = object(await this.get(`/api/profiles/${encodeURIComponent(account.id)}`));
    // Fitia's profile endpoint no longer includes isPremium; ask the dedicated premium endpoint instead.
    // A present but malformed isPremium is still rejected.
    const isPremium = data.isPremium === undefined ? (await this.premium()).isPremium : boolean(data.isPremium);
    return {
      id: account.id,
      email: optionalString(data.email),
      name: optionalString(data.name),
      country: optionalString(data.country),
      isPremium,
      useCase: optionalString(data.useCase),
      goal: optionalString(data.goal),
      sex: optionalString(data.sex),
      creationDate: optionalString(data.creationDate),
    };
  }

  async premium() {
    const data = object(await this.get("/api/subscription/premium"));
    return { isPremium: boolean(data.isPremium) };
  }

  async foods(country: string, query?: string, limit?: number) {
    const data = await this.request(`${FITIA}/api/foods?countryCode=${encodeURIComponent(country)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!Array.isArray(data)) invalidResponse();
    const foods = data.map((value) => {
      const item = object(value);
      if (!Number.isSafeInteger(item.id) || Number(item.id) < 0) invalidResponse();
      const names = object(item.names);
      return {
        id: item.id as number,
        names: { en: requiredString(names.en), es: requiredString(names.es) },
        category: requiredString(item.category),
      };
    });
    const normalize = (value: string) =>
      value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
    const matching = query
      ? foods.filter((item) =>
          [item.names.en, item.names.es].some((name) => normalize(name).includes(normalize(query))),
        )
      : foods;
    const result = limit ? matching.slice(0, limit) : matching;
    return {
      scope: "onboarding-preferences",
      country,
      total: matching.length,
      count: result.length,
      foods: result,
      limitations: [
        "Onboarding food preferences only. No nutrients, serving sizes, full food search, or meal history.",
      ],
    };
  }

  async searchFoods(query: string, country = "pe", language = "es", limit = 10) {
    if (
      !query.trim() ||
      query.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(query) ||
      !/^[a-z]{2}$/i.test(country) ||
      !/^(es|en)$/i.test(language) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new CliError(
        "INVALID_ARGUMENT",
        "Invalid food search options.",
        "Use a query, a two letter country, language es or en, and a limit from 1 to 50.",
      );
    }
    const data = await this.request("https://us-central1-fitia-27c84.cloudfunctions.net/generalSearchV5", {
      method: "POST",
      headers: {
        Authorization: requireToken(this.token),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        search: query.trim(),
        search_own_db: true,
        language: language.toUpperCase(),
        size: limit,
        app_platform: "iOS",
        app_build_number: 1069,
        country: country.toUpperCase(),
        search_verified: true,
      }),
    });
    return searchFoodsResponse(data, query.trim(), country.toLowerCase(), language.toLowerCase(), limit);
  }

  async suggestFoods(request: FoodSuggestionRequest) {
    return this.request("https://planner.fitia.app/api/v1/yuki/food-suggestions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireToken(this.token)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
    });
  }
}
