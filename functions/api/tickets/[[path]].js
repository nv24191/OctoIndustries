import { handleTickets } from '../../_lib/admin.js';

export async function onRequest(context) {
  try {
    return await handleTickets(context.request, context.env);
  } catch (error) {
    console.error('Ticket request failed:', error);
    return new Response(JSON.stringify({
      error: error.status && error.status < 500 ? error.message : 'The ticket service could not complete the request.',
    }), {
      status: error.status || 500,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}