import { Router, Request, Response } from 'express';
import { OPERATOR_NAME, CLIENT_NAME } from '../config/constants';
import { ARLO_MODEL } from '../config/models';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    operator: OPERATOR_NAME,
    client: CLIENT_NAME,
    pipeline: {
      ears: 'elevenlabs-scribe',
      brain: ARLO_MODEL,
      mouth: 'elevenlabs',
      memory: 'sqlite-6-layer',
    },
  });
});

export default router;
