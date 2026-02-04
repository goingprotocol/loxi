
import { Resend } from 'resend';

// Ensure RESEND_API_KEY is in your .env
const resend = new Resend(process.env.RESEND_API_KEY);

interface EmailParams {
    to: string;
    subject: string;
    html: string;
}

export class EmailService {

    static async sendFailureNotification(to: string, shipmentId: string, reason: string): Promise<boolean> {
        if (!to) {
            console.warn('[EmailService] No recipient email provided.');
            return false;
        }

        const html = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ffcccc; background-color: #fff5f5; border-radius: 8px;">
                <h2 style="color: #cc0000;">⚠️ Shipment Processing Failed</h2>
                <p>Hello,</p>
                <p>We encountered a critical error while processing your shipment <strong>${shipmentId}</strong>.</p>
                
                <div style="background: white; padding: 15px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #cc0000;">
                    <strong>Reason:</strong> ${reason}
                </div>

                <p>The shipment has been marked as <strong>FAILED</strong> in your dashboard.</p>
                <p>Please log in to the portal to correct the address or data.</p>
                
                <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/logistics/dashboard" style="display: inline-block; padding: 10px 20px; background-color: #cc0000; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">
                    Go to Dashboard
                </a>
            </div>
        `;

        try {
            const { data, error } = await resend.emails.send({
                from: 'Going Logistics <alert@resend.dev>', // Update with verified domain in Prod
                to: [to],
                subject: `Action Required: Shipment ${shipmentId} Failed`,
                html: html,
            });

            if (error) {
                console.error('[EmailService] Resend Error:', error);
                return false;
            }

            console.log(`[EmailService] Failure notification sent to ${to} for ${shipmentId}`);
            return true;
        } catch (err) {
            console.error('[EmailService] Network/Exception Error:', err);
            return false;
        }
    }
}
