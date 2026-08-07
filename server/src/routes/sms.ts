import { Router, Request, Response } from 'express';
import { sendTestSms } from '../services/sms';

const router = Router();

// Manual end-to-end delivery check: texts SMS_NOTIFY_TO over the active
// provider and returns the transport receipt (message SID + status), so live
// carrier delivery can be verified with a phone in hand.
router.post('/sms/test', async (_req: Request, res: Response) => {
  try {
    const receipt = await sendTestSms();
    res.json({ ok: true, ...receipt });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'send failed' });
  }
});

export default router;
