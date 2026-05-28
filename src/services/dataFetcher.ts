import axios, { type AxiosResponse, type AxiosRequestConfig } from "axios";
import https from "https";
import fs from "fs";
import path from "path";

// A robust, zero-dependency .env loader to ensure variables are loaded locally
function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const [key, ...valueParts] = trimmed.split("=");
          const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
          if (key.trim() && !process.env[key.trim()]) {
            process.env[key.trim()] = value;
          }
        }
      });
    }
  } catch (error) {
    // Ignore error silently
  }
}
loadEnv();

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const httpsAgent = new https.Agent({ keepAlive: true });

// Interface for proxy configuration compatible with AxiosProxyConfig
interface ProxyConfig {
  protocol: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

// Parse custom proxy URL (e.g. http://username:password@host:port)
function parseProxyUrl(proxyUrl: string): ProxyConfig | undefined {
  try {
    const parsed = new URL(proxyUrl);
    const config: ProxyConfig = {
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: parseInt(parsed.port || "80", 10),
    };
    if (parsed.username) {
      config.auth = {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password || ""),
      };
    }
    return config;
  } catch (error) {
    console.error("[Proxy Config] Invalid proxy URL:", proxyUrl);
    return undefined;
  }
}

// Public Proxy Rotator Cache
let cachedPublicProxies: string[] = [];
let lastFetchedTime = 0;

async function getPublicProxies(): Promise<string[]> {
  const NOW = Date.now();
  // Cache proxy list for 10 minutes to avoid overloading the API
  if (cachedPublicProxies.length > 0 && (NOW - lastFetchedTime) < 10 * 60 * 1000) {
    return cachedPublicProxies;
  }

  try {
    console.log("[Proxy Rotator] Fetching fresh public proxy list...");
    const response = await axios.get(
      "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all",
      { timeout: 5000 }
    );
    if (response.data && typeof response.data === "string") {
      const proxies = response.data
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p.includes(":"));
      if (proxies.length > 0) {
        cachedPublicProxies = proxies;
        lastFetchedTime = NOW;
        console.log(`[Proxy Rotator] Successfully loaded ${proxies.length} public proxies.`);
        return cachedPublicProxies;
      }
    }
  } catch (error: any) {
    console.warn("[Proxy Rotator] Failed to fetch dynamic proxy list, using static fallbacks:", error.message);
  }

  // Robust fallback list of active free public HTTP/HTTPS proxies
  const fallbacks = [
    "20.205.61.143:80",
    "185.228.192.174:80",
    "103.87.168.106:80",
    "41.60.231.107:8080",
    "103.152.112.162:80",
  ];
  cachedPublicProxies = fallbacks;
  lastFetchedTime = NOW;
  return fallbacks;
}

export async function wajikFetch(
  url: string,
  axiosConfig?: AxiosRequestConfig<any>,
  callback?: (response: AxiosResponse) => void,
): Promise<any> {
  const provider = (process.env.PROXY_PROVIDER || "none").toLowerCase().trim();
  const apiKey = process.env.PROXY_API_KEY || "";
  const customProxyUrl = process.env.PROXY_URL || "";

  const baseHeaders = {
    ...axiosConfig?.headers,
    "User-Agent": userAgent,
    "Referer": "https://otakudesu.blog/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  // 1. ScraperAPI Integration
  if (provider === "scraperapi" && apiKey) {
    const encodedUrl = encodeURIComponent(url);
    const scraperUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodedUrl}`;
    console.log(`[Proxy] Routing request via ScraperAPI for: ${url}`);
    
    const requestConfig: AxiosRequestConfig = {
      method: axiosConfig?.method || "GET",
      timeout: 30000,
      headers: axiosConfig?.headers,
      ...axiosConfig,
      url: scraperUrl,
    };
    
    const response = await axios(requestConfig);
    if (callback) callback(response);
    return response.data;
  }

  // 2. ZenRows Integration
  if (provider === "zenrows" && apiKey) {
    const encodedUrl = encodeURIComponent(url);
    const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${apiKey}&url=${encodedUrl}`;
    console.log(`[Proxy] Routing request via ZenRows for: ${url}`);
    
    const requestConfig: AxiosRequestConfig = {
      method: axiosConfig?.method || "GET",
      timeout: 30000,
      headers: axiosConfig?.headers,
      ...axiosConfig,
      url: zenrowsUrl,
    };
    
    const response = await axios(requestConfig);
    if (callback) callback(response);
    return response.data;
  }

  // 3. Custom Proxy (BrightData, Webshare, or private proxy)
  if (provider === "custom" && customProxyUrl) {
    const parsedProxy = parseProxyUrl(customProxyUrl);
    console.log(`[Proxy] Routing request via custom proxy (${parsedProxy?.host}) for: ${url}`);
    
    const requestConfig: AxiosRequestConfig = {
      url,
      method: axiosConfig?.method || "GET",
      httpsAgent,
      timeout: 15000,
      headers: baseHeaders,
      ...axiosConfig,
    };
    if (parsedProxy) {
      requestConfig.proxy = parsedProxy;
    }
    
    const response = await axios(requestConfig);
    if (callback) callback(response);
    return response.data;
  }

  // 4. Public Proxy (Rotator with Auto-Retry)
  if (provider === "public") {
    const proxies = await getPublicProxies();
    const retries = Math.min(5, proxies.length);
    let lastError: any = null;

    // Shuffle a slice of proxies to avoid picking the exact same one under concurrent loads
    const shuffledProxies = [...proxies].sort(() => 0.5 - Math.random()).slice(0, retries);

    for (let attempt = 0; attempt < retries; attempt++) {
      const proxyStr = shuffledProxies[attempt];
      try {
        const [host, portStr] = proxyStr.split(":");
        const port = parseInt(portStr || "80", 10);
        console.log(`[Proxy Rotator] Attempt ${attempt + 1}/${retries} using: http://${host}:${port} for ${url}`);

        const requestConfig: AxiosRequestConfig = {
          url,
          method: axiosConfig?.method || "GET",
          timeout: 6000, // Short timeout to fail-over fast if proxy is dead
          headers: baseHeaders,
          proxy: {
            protocol: "http",
            host,
            port,
          },
          ...axiosConfig,
        };

        const response = await axios(requestConfig);
        if (callback) callback(response);
        return response.data;
      } catch (error: any) {
        console.warn(`[Proxy Rotator] Attempt ${attempt + 1} failed: ${error.message}`);
        lastError = error;
      }
    }

    // Direct fallback if all proxies fail
    console.warn("[Proxy Rotator] All public proxies failed. Attempting direct fallback connection...");
    try {
      const requestConfig: AxiosRequestConfig = {
        url,
        method: axiosConfig?.method || "GET",
        httpsAgent,
        timeout: 10000,
        headers: baseHeaders,
        ...axiosConfig,
      };
      const response = await axios(requestConfig);
      if (callback) callback(response);
      return response.data;
    } catch (directError) {
      throw lastError || directError;
    }
  }

  // 5. Default direct fetch (No Proxy)
  const requestConfig: AxiosRequestConfig = {
    url,
    method: axiosConfig?.method || "GET",
    httpsAgent,
    timeout: 10000,
    headers: baseHeaders,
    ...axiosConfig,
  };
  const response = await axios(requestConfig);

  if (callback) callback(response);
  return response.data;
}

export async function getFinalUrl(
  url: string,
  axiosConfig?: AxiosRequestConfig<any>,
): Promise<any> {
  const provider = (process.env.PROXY_PROVIDER || "none").toLowerCase().trim();
  const apiKey = process.env.PROXY_API_KEY || "";
  const customProxyUrl = process.env.PROXY_URL || "";

  const baseHeaders = {
    ...axiosConfig?.headers,
    "User-Agent": userAgent,
    "Referer": "https://otakudesu.blog/",
  };

  const makeHeadRequest = async (targetUrl: string, config: AxiosRequestConfig<any>) => {
    return await axios.head(targetUrl, {
      httpsAgent,
      timeout: 8000,
      headers: baseHeaders,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
      ...config,
    });
  };

  try {
    let response;

    if (provider === "scraperapi" && apiKey) {
      const encodedUrl = encodeURIComponent(url);
      const scraperUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodedUrl}`;
      response = await makeHeadRequest(scraperUrl, axiosConfig || {});
    } else if (provider === "zenrows" && apiKey) {
      const encodedUrl = encodeURIComponent(url);
      const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${apiKey}&url=${encodedUrl}`;
      response = await makeHeadRequest(zenrowsUrl, axiosConfig || {});
    } else if (provider === "custom" && customProxyUrl) {
      const parsedProxy = parseProxyUrl(customProxyUrl);
      const requestConfig: AxiosRequestConfig = {
        httpsAgent,
        timeout: 8000,
        headers: baseHeaders,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        ...axiosConfig,
      };
      if (parsedProxy) {
        requestConfig.proxy = parsedProxy;
      }
      response = await axios.head(url, requestConfig);
    } else if (provider === "public") {
      const proxies = await getPublicProxies();
      const retries = Math.min(3, proxies.length);
      const shuffledProxies = [...proxies].sort(() => 0.5 - Math.random()).slice(0, retries);

      for (let attempt = 0; attempt < retries; attempt++) {
        const proxyStr = shuffledProxies[attempt];
        try {
          const [host, portStr] = proxyStr.split(":");
          const port = parseInt(portStr || "80", 10);
          response = await axios.head(url, {
            timeout: 5000,
            headers: baseHeaders,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
            proxy: {
              protocol: "http",
              host,
              port,
            },
            ...axiosConfig,
          });
          break;
        } catch (error) {
          // Silent retry
        }
      }

      if (!response) {
        response = await makeHeadRequest(url, axiosConfig || {});
      }
    } else {
      response = await makeHeadRequest(url, axiosConfig || {});
    }

    const location = response?.headers["location"];
    if (location) return location;
    return url;
  } catch (error) {
    console.error(`[Proxy] Error resolving final URL for ${url}:`, error);
    return url;
  }
}

export async function getFinalUrls(
  urls: string[],
  config: {
    axiosConfig?: AxiosRequestConfig<any>;
    retryConfig?: {
      retries?: number;
      delay?: number;
    };
  },
): Promise<any[]> {
  const { retries = 3, delay = 1000 } = config.retryConfig || {};

  const retryRequest = async (url: string): Promise<any> => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await getFinalUrl(url, config.axiosConfig);
      } catch (error) {
        if (attempt === retries) throw error;

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const requests = urls.map((url) => retryRequest(url));
  const responses = await Promise.allSettled(requests);

  const results = responses.map((response) => {
    if (response.status === "fulfilled") return response.value;

    return "";
  });

  return results;
}


