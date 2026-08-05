// src/index.js
// Notice we REMOVED the import fernet line from the top of the file.

const ALLOWED_ORIGIN = "https://your-custom-site.com"; 

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { 
        status: 405, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    try {
      const body = await request.json();
      const { token } = body;

      if (!token) {
         return new Response(JSON.stringify({ error: "Token is missing" }), { 
           status: 400, 
           headers: { ...corsHeaders, "Content-Type": "application/json" } 
         });
      }

      // --- THE FIX ---
      // We dynamically import fernet inside the handler. 
      // This ensures the random bytes are generated safely inside the request context.
      const fernetModule = await import('fernet');
      const fernet = fernetModule.default || fernetModule;
      // ---------------

      const secret = new fernet.Secret(env.FERNET_SECRET);
      
      const receivedToken = new fernet.Token({
          secret: secret,
          token: token,
          ttl: 300 // 5 minutes expiration
      });

      const decryptedString = receivedToken.decode();
      const decryptedData = JSON.parse(decryptedString);
      
      return new Response(JSON.stringify({ 
        success: true, 
        data: decryptedData 
      }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });

        } catch (error) {
      // TEMPORARY DEBUGGING FIX: Expose the exact cryptographic error
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 400, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

  }
};
