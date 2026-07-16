import { Router, Request, Response } from 'express';
import { resolveIntegrations, integrationCounts, CATEGORY_ORDER } from '../config/integrations';

const router = Router();

router.get('/integrations', (_req: Request, res: Response) => {
  const items = resolveIntegrations();
  res.json({
    categoryOrder: CATEGORY_ORDER,
    counts: integrationCounts(items),
    integrations: items,
  });
});

export default router;
