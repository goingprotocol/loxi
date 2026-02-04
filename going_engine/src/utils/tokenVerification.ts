import { PrivyClient } from '@privy-io/server-auth';

// Nota: Asegúrate de que las variables de entorno PRIVY_APP_SECRET y NEXT_PUBLIC_PRIVY_APP_ID
// estén disponibles en el entorno del socket-server (ej. en su propio archivo .env)

const privyClient = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID || '',
  process.env.PRIVY_APP_SECRET || ''
);

export async function verifyIdentityToken(idToken: string) {
  try {
    const verifiedUser = await privyClient.verifyAuthToken(idToken);
    return verifiedUser;
  } catch (error) {
    console.error('Error verifying Privy token:', error);
    // Devolvemos null en lugar de lanzar un error para que el llamador pueda manejarlo
    return null;
  }
}
