// src/index.js
import { createClient } from '@libsql/client/web';

const ALLOWED_ORIGIN = "https://jasmine-verify.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ==========================================
// BFS ALGORITHM HELPER
// ==========================================
function findBestCombinationUrls(products, targetCents) {
  const validProducts = products.filter(
    p => p.published && (p.price || 0) <= targetCents
  );

  if (validProducts.length === 0) return [];

  const queue = [
    {
      sum: 0,
      combo: [],
      lastIndex: -1
    }
  ];

  let head = 0;

  let bestComboIndices = null;
  let bestComboSales = Infinity;

  while (head < queue.length) {
    const current = queue[head++];

    for (
      let i = current.lastIndex + 1;
      i < validProducts.length;
      i++
    ) {
      const product = validProducts[i];
      const price = product.price || 0;
      const newSum = current.sum + price;

      if (newSum === targetCents) {
        const newCombo = [...current.combo, i];

        let newComboSales = 0;

        for (const idx of newCombo) {
          newComboSales +=
            validProducts[idx].sales_count || 0;
        }

        if (
          !bestComboIndices ||
          newComboSales < bestComboSales
        ) {
          bestComboIndices = newCombo;
          bestComboSales = newComboSales;
        }
      } else if (newSum < targetCents) {
        queue.push({
          sum: newSum,
          combo: [...current.combo, i],
          lastIndex: i
        });
      }
    }

    if (
      bestComboIndices &&
      head < queue.length &&
      queue[head].combo.length >= bestComboIndices.length
    ) {
      break;
    }
  }

  if (bestComboIndices) {
    return bestComboIndices.map(
      idx =>
        validProducts[idx].short_url ||
        validProducts[idx].url ||
        ""
    );
  }

  return [];
}


// ==========================================
// MAIN WORKER
// ==========================================
export default {
  async fetch(request, env, ctx) {

    // ============================================================
    // CORS PREFLIGHT
    // ============================================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);


    // ============================================================
    // ROUTE 1: /decrypt
    // ============================================================

    if (url.pathname === "/decrypt") {

      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            error: "Method not allowed"
          }),
          {
            status: 405,
            headers: corsHeaders
          }
        );
      }

      try {
        const body = await request.json();
        const { token } = body;

        if (!token) {
          return new Response(
            JSON.stringify({
              error: "Token is missing"
            }),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const fernetModule = await import("fernet");
        const fernet =
          fernetModule.default || fernetModule;

        const secret =
          new fernet.Secret(env.FERNET_SECRET);

        const receivedToken = new fernet.Token({
          secret,
          token,
          ttl: 9999999
        });

        const decryptedData = JSON.parse(
          receivedToken.decode()
        );

        return new Response(
          JSON.stringify({
            success: true,
            data: decryptedData
          }),
          {
            status: 200,
            headers: corsHeaders
          }
        );

      } catch (error) {

        console.error("Decrypt error:", error);

        return new Response(
          JSON.stringify({
            error: "Invalid, expired, or tampered token."
          }),
          {
            status: 400,
            headers: corsHeaders
          }
        );
      }
    }


    // ============================================================
    // ROUTE 2: /savedata
    // ============================================================

    else if (url.pathname === "/savedata") {

      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            error: "Method not allowed"
          }),
          {
            status: 405,
            headers: corsHeaders
          }
        );
      }

      try {
        const reqBody = await request.json();

        if (!reqBody || !reqBody.name) {
          return new Response(
            JSON.stringify({
              error: "Missing required 'name' field"
            }),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const turso = createClient({
          url: env.TURSO_URL,
          authToken: env.TURSO_AUTH_TOKEN
        });

        await turso.execute(`
          CREATE TABLE IF NOT EXISTS location (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            payload TEXT
          )
        `);

        await turso.execute({
          sql: `
            INSERT INTO location (name, payload)
            VALUES (?, ?)
          `,
          args: [
            reqBody.name,
            JSON.stringify(reqBody)
          ]
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: "Data saved to Turso",
            recorded_name: reqBody.name
          }),
          {
            status: 200,
            headers: corsHeaders
          }
        );

      } catch (error) {

        console.error("Database error:", error);

        return new Response(
          JSON.stringify({
            error: `Database failure: ${error.message}`
          }),
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }


    // ============================================================
    // ROUTE 3: /products
    // ============================================================

    else if (url.pathname === "/products") {

      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            error: "Method not allowed"
          }),
          {
            status: 405,
            headers: corsHeaders
          }
        );
      }

      try {

        // --------------------------------------------------------
        // 1. Decrypt incoming token
        // --------------------------------------------------------

        const body = await request.json();

        if (!body.token) {
          return new Response(
            JSON.stringify([]),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const fernetModule = await import("fernet");
        const fernet =
          fernetModule.default || fernetModule;

        const secret =
          new fernet.Secret(env.FERNET_SECRET);

        const receivedToken = new fernet.Token({
          secret,
          token: body.token,
          ttl: 300
        });

        const decryptedData = JSON.parse(
          receivedToken.decode()
        );

        // --------------------------------------------------------
        // 2. Extract amount
        // --------------------------------------------------------

        const amountUsd = decryptedData.amount;

        if (
          typeof amountUsd !== "number" ||
          amountUsd <= 0
        ) {
          return new Response(
            JSON.stringify([]),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        const targetCents = amountUsd * 100;

        // --------------------------------------------------------
        // 3. Fetch Gumroad products
        // --------------------------------------------------------

        const gumroadResponse = await fetch(
          "https://api.gumroad.com/v2/products",
          {
            headers: {
              "Authorization":
                `Bearer ${env.GUMROAD_ACCESS_TOKEN}`,
              "Content-Type":
                "application/json"
            }
          }
        );

        if (!gumroadResponse.ok) {
          return new Response(
            JSON.stringify([]),
            {
              status: 500,
              headers: corsHeaders
            }
          );
        }

        const gumroadData =
          await gumroadResponse.json();

        if (!gumroadData.success) {
          return new Response(
            JSON.stringify([]),
            {
              status: 500,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // 4. Calculate best combination
        // --------------------------------------------------------

        const urlArray =
          findBestCombinationUrls(
            gumroadData.products,
            targetCents
          );

        return new Response(
          JSON.stringify(urlArray),
          {
            status: 200,
            headers: corsHeaders
          }
        );

      } catch (error) {

        console.error("Products error:", error);

        return new Response(
          JSON.stringify([]),
          {
            status: 400,
            headers: corsHeaders
          }
        );
      }
    }


    // ============================================================
    // ROUTE 4: /product
    //
    // POST:
    // {
    //   "permalink": "xfvszl"
    // }
    //
    // Returns:
    // {
    //   "success": true,
    //   "product": {
    //     "name": "...",
    //     "price_cents": 500
    //   }
    // }
    // ============================================================

    else if (url.pathname === "/product") {

      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            error: "Method not allowed"
          }),
          {
            status: 405,
            headers: corsHeaders
          }
        );
      }

      try {

        const body = await request.json();

        const permalink = body.permalink;

        if (!permalink) {
          return new Response(
            JSON.stringify({
              error: "Missing product permalink"
            }),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // Fetch public Gumroad product page
        //
        // No API token is exposed to the browser.
        // --------------------------------------------------------

        const gumroadUrl =
          `https://emh1.gumroad.com/l/${encodeURIComponent(permalink)}`;

        const gumroadResponse = await fetch(
          gumroadUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0"
            }
          }
        );

        if (!gumroadResponse.ok) {
          return new Response(
            JSON.stringify({
              error: "Could not fetch Gumroad product",
              status: gumroadResponse.status
            }),
            {
              status: 502,
              headers: corsHeaders
            }
          );
        }

        const html =
          await gumroadResponse.text();

        // --------------------------------------------------------
        // Extract data-page
        // --------------------------------------------------------

        const match = html.match(
          /<div\s+id=["']app["'][^>]*data-page=["'](.*?)["']/s
        );

        if (!match) {
          return new Response(
            JSON.stringify({
              error: "Gumroad product data not found"
            }),
            {
              status: 502,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // Decode HTML entities
        // --------------------------------------------------------

        const dataPage = match[1]
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");

        // --------------------------------------------------------
        // Parse JSON
        // --------------------------------------------------------

        const pageData =
          JSON.parse(dataPage);

        const product =
          pageData?.props?.product;

        if (!product) {
          return new Response(
            JSON.stringify({
              error: "Product information not found"
            }),
            {
              status: 502,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // Return ONLY required product information
        // --------------------------------------------------------

        return new Response(
          JSON.stringify({
            success: true,
            product: {
              name: product.name,
              price_cents: product.price_cents
            }
          }),
          {
            status: 200,
            headers: corsHeaders
          }
        );

      } catch (error) {

        console.error("Product error:", error);

        return new Response(
          JSON.stringify({
            error: "Failed to retrieve product"
          }),
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }


    // ============================================================
    // ROUTE 5: /checkPurchase
    //
    // POST:
    // {
    //   "product_permalink": "xfvszl",
    //   "referrer": "track_abc123xyz"
    // }
    //
    // Returns:
    // {
    //   "purchased": true
    // }
    // ============================================================

    else if (url.pathname === "/checkPurchase") {

      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            error: "Method not allowed"
          }),
          {
            status: 405,
            headers: corsHeaders
          }
        );
      }

      try {

        const body = await request.json();

        const {
          product_permalink,
          referrer
        } = body;

        // --------------------------------------------------------
        // Validate input
        // --------------------------------------------------------

        if (!product_permalink) {
          return new Response(
            JSON.stringify({
              error:
                "Missing product_permalink"
            }),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        if (!referrer) {
          return new Response(
            JSON.stringify({
              error:
                "Missing referrer"
            }),
            {
              status: 400,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // Gumroad API
        //
        // Token NEVER reaches the browser.
        // --------------------------------------------------------

        const gumroadResponse = await fetch(
          "https://api.gumroad.com/v2/sales",
          {
            method: "GET",
            headers: {
              "Authorization":
                `Bearer ${env.GUMROAD_ACCESS_TOKEN}`,
              "Content-Type":
                "application/json"
            }
          }
        );

        if (!gumroadResponse.ok) {

          console.error(
            "Gumroad sales API:",
            gumroadResponse.status
          );

          return new Response(
            JSON.stringify({
              purchased: false,
              error:
                "Gumroad API request failed"
            }),
            {
              status: 502,
              headers: corsHeaders
            }
          );
        }

        const gumroadData =
          await gumroadResponse.json();

        if (
          !gumroadData.success ||
          !Array.isArray(gumroadData.sales)
        ) {
          return new Response(
            JSON.stringify({
              purchased: false
            }),
            {
              status: 200,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // Find matching sale
        //
        // Same logic as your original HTML:
        //
        // 1. Product permalink must match
        // 2. Referrer must match
        // --------------------------------------------------------

        const matchingSale =
          gumroadData.sales.find(sale => {

            const correctProduct =
              sale.product_permalink ===
              product_permalink;

            const correctReferrer =
              sale.referrer === referrer;

            return (
              correctProduct &&
              correctReferrer
            );
          });

        // --------------------------------------------------------
        // Purchase found
        // --------------------------------------------------------

        if (matchingSale) {

          return new Response(
            JSON.stringify({
              purchased: true
            }),
            {
              status: 200,
              headers: corsHeaders
            }
          );
        }

        // --------------------------------------------------------
        // No purchase found
        // --------------------------------------------------------

        return new Response(
          JSON.stringify({
            purchased: false
          }),
          {
            status: 200,
            headers: corsHeaders
          }
        );

      } catch (error) {

        console.error(
          "Purchase verification error:",
          error
        );

        return new Response(
          JSON.stringify({
            purchased: false
          }),
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }
    }


    // ============================================================
    // 404
    // ============================================================

    return new Response(
      JSON.stringify({
        error: "Endpoint not found"
      }),
      {
        status: 404,
        headers: corsHeaders
      }
    );
  }
};
