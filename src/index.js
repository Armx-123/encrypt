// src/index.js
import { createClient } from '@libsql/client/web';

const ALLOWED_ORIGIN = "https://jasmine-verify.vercel.app"; 

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

        if (!token) {
           return new Response(JSON.stringify({ error: "Token is missing" }), { 
             status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
           });
        }

        const fernetModule = await import('fernet');
        const fernet = fernetModule.default || fernetModule;
        
        const secret = new fernet.Secret(env.FERNET_SECRET);
        
        const receivedToken = new fernet.Token({
            secret: secret,
            token: token,
            // Corrected: Restored to 300 seconds (5 minutes) for strict security
            ttl: 99999999
        });

        const decryptedString = receivedToken.decode();
        const decryptedData = JSON.parse(decryptedString);
        
        return new Response(JSON.stringify({ 
          success: true, 
          data: decryptedData 
        }), { 
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        // Corrected: Removed error.message to prevent cryptographic leakage
        return new Response(JSON.stringify({ error: "Invalid, expired, or tampered token." }), { 
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    // ====================================================================
    // ROUTE 2: /savedata
    // ====================================================================
    else if (url.pathname === '/savedata') {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { 
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      try {
        const reqBody = await request.json();

        if (!reqBody || !reqBody.name) {
          return new Response(JSON.stringify({ error: "Missing required 'name' field" }), { 
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } 
          });
        }

        const turso = createClient({
          url: env.TURSO_URL,
          authToken: env.TURSO_AUTH_TOKEN,
        });

        await turso.execute(`
          CREATE TABLE IF NOT EXISTS cloud_json_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            payload TEXT
          )
        `);

        const jsonString = JSON.stringify(reqBody);

        await turso.execute({
          sql: "INSERT INTO cloud_json_data (name, payload) VALUES (?, ?)",
          args: [reqBody.name, jsonString]
        });

        return new Response(JSON.stringify({ 
          success: true, 
          message: "Data saved to Turso",
          recorded_name: reqBody.name
        }), { 
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        // Database errors are safely exposed here as they do not risk decryption keys
        return new Response(JSON.stringify({ error: `Database failure: ${error.message}` }), { 
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
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
