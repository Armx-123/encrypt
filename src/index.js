// src/index.js
import { createClient } from '@libsql/client/web';

const ALLOWED_ORIGIN = "https://jasmine-verify.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ==========================================
// BFS ALGORITHM HELPER (Optimized for V8 Isolates)
// ==========================================
function findBestCombinationUrls(products, targetCents) {
  const validProducts = products.filter(p => p.published && (p.price || 0) <= targetCents);
  if (validProducts.length === 0) return [];

  const queue = [{ sum: 0, combo: [], lastIndex: -1 }];
  let head = 0; // Optimization to prevent O(N) shift penalties
  
  let bestComboIndices = null;
  let bestComboSales = Infinity;

  while (head < queue.length) {
    const current = queue[head++];

    for (let i = current.lastIndex + 1; i < validProducts.length; i++) {
      const product = validProducts[i];
      const price = product.price || 0;
      const newSum = current.sum + price;

      if (newSum === targetCents) {
        const newCombo = [...current.combo, i];
        
        let newComboSales = 0;
        for (const idx of newCombo) {
          newComboSales += (validProducts[idx].sales_count || 0);
        }

        if (!bestComboIndices || newComboSales < bestComboSales) {
          bestComboIndices = newCombo;
          bestComboSales = newComboSales;
        }
      } else if (newSum < targetCents) {
        queue.push({ sum: newSum, combo: [...current.combo, i], lastIndex: i });
      }
    }

    if (bestComboIndices && head < queue.length && queue[head].combo.length >= bestComboIndices.length) {
      break;
    }
  }

  if (bestComboIndices) {
    // Returns only the URLs as requested
    return bestComboIndices.map(idx => validProducts[idx].short_url || validProducts[idx].url || "");
  }
  
  return [];
}

export default {
  async fetch(request, env, ctx) {
    // 1. Universal CORS Preflight Handling
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ====================================================================
    // ROUTE 1: /decrypt
    // ====================================================================
    if (url.pathname === '/decrypt') {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { 
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      try {
        const body = await request.json();
        const { token } = body;

        if (!token) return new Response(JSON.stringify({ error: "Token is missing" }), { status: 400, headers: corsHeaders });

        const fernetModule = await import('fernet');
        const fernet = fernetModule.default || fernetModule;
        const secret = new fernet.Secret(env.FERNET_SECRET);
        
        const receivedToken = new fernet.Token({ secret, token, ttl: 300 });
        const decryptedData = JSON.parse(receivedToken.decode());
        
        return new Response(JSON.stringify({ success: true, data: decryptedData }), { 
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid, expired, or tampered token." }), { 
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    // ====================================================================
    // ROUTE 2: /savedata
    // ====================================================================
    else if (url.pathname === '/savedata') {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

      try {
        const reqBody = await request.json();
        if (!reqBody || !reqBody.name) return new Response(JSON.stringify({ error: "Missing required 'name' field" }), { status: 400, headers: corsHeaders });

        const turso = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });

        await turso.execute(`
          CREATE TABLE IF NOT EXISTS location (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            payload TEXT
          )
        `);

        await turso.execute({
          sql: "INSERT INTO location (name, payload) VALUES (?, ?)",
          args: [reqBody.name, JSON.stringify(reqBody)]
        });

        return new Response(JSON.stringify({ success: true, message: "Data saved to Turso", recorded_name: reqBody.name }), { 
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: `Database failure: ${error.message}` }), { 
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    // ====================================================================
    // ROUTE 3: /products
    // ====================================================================
    else if (url.pathname === '/products') {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

      try {
        // 1. Decrypt the incoming token
        const body = await request.json();
        if (!body.token) return new Response(JSON.stringify([]), { status: 400, headers: corsHeaders });

        const fernetModule = await import('fernet');
        const fernet = fernetModule.default || fernetModule;
        const secret = new fernet.Secret(env.FERNET_SECRET);
        
        const receivedToken = new fernet.Token({ secret, token: body.token, ttl: 300 });
        const decryptedData = JSON.parse(receivedToken.decode());
        
        // 2. Extract amount
        const amountUsd = decryptedData.amount;
        if (typeof amountUsd !== 'number' || amountUsd <= 0) {
          return new Response(JSON.stringify([]), { status: 400, headers: corsHeaders });
        }
        const targetCents = amountUsd * 100;

        // 3. Fetch Gumroad Products
        const gumroadResponse = await fetch("https://api.gumroad.com/v2/products", {
          headers: {
            "Authorization": `Bearer ${env.GUMROAD_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          }
        });

        if (!gumroadResponse.ok) return new Response(JSON.stringify([]), { status: 500, headers: corsHeaders });
        
        const gumroadData = await gumroadResponse.json();
        if (!gumroadData.success) return new Response(JSON.stringify([]), { status: 500, headers: corsHeaders });

        // 4. Calculate best combination and return ONLY the array
        const urlArray = findBestCombinationUrls(gumroadData.products, targetCents);
        
        return new Response(JSON.stringify(urlArray), { 
          status: 200, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        // If decryption fails or another error occurs, fail silently with an empty array
        return new Response(JSON.stringify([]), { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    // ====================================================================
    // 404 CATCH-ALL
    // ====================================================================
    return new Response(JSON.stringify({ error: "Endpoint not found" }), { 
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
};
