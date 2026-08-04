// src/index.js
import fernet from 'fernet';

// 1. Strict CORS Configuration
// Replace this with your actual website domain to prevent other sites from using your API
const ALLOWED_ORIGIN = "https://your-custom-site.com"; 

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    // 2. Handle CORS Preflight Requests (Browsers send this before the actual POST)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 3. Block anything that isn't a POST request
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { 
        status: 405, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    try {
      // 4. Extract the token from the request body
      const body = await request.json();
      const { token } = body;

      if (!token) {
         return new Response(JSON.stringify({ error: "Token is missing" }), { 
           status: 400, 
           headers: { ...corsHeaders, "Content-Type": "application/json" } 
         });
      }

      // 5. Initialize Fernet with the secret key injected by Cloudflare
      const secret = new fernet.Secret(env.FERNET_SECRET);
      
      const receivedToken = new fernet.Token({
          secret: secret,
          token: token,
          ttl: 300 // 5 minutes expiration
      });

      // 6. Decrypt the token
      const decryptedString = receivedToken.decode();
      const decryptedData = JSON.parse(decryptedString);
      
      // 7. Return the successful decrypted JSON
      return new Response(JSON.stringify({ 
        success: true, 
        data: decryptedData 
      }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });

    } catch (error) {
      // 8. Safely catch tampered, expired, or malformed tokens
      return new Response(JSON.stringify({ error: "Invalid, expired, or tampered token." }), { 
        status: 400, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};
