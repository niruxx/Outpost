import { Router, type Request } from 'express';
import { requireAuth, requireServerAccess } from '../auth/middleware.js';
import { getServer } from '../services/serverService.js';
import { getServerPermissions, getUserById } from '../services/userService.js';
import { capabilityMatrix, instanceCapabilities } from '../services/gameCapabilityService.js';
import { HttpError } from '../utils/asyncHandler.js';
export const gameCapabilityCatalogRouter = Router();
gameCapabilityCatalogRouter.use(requireAuth);
gameCapabilityCatalogRouter.get('/', (_req, res) => res.json(capabilityMatrix()));
export const instanceCapabilitiesRouter = Router({ mergeParams: true });
instanceCapabilitiesRouter.use(requireAuth, (req, _res, next) => {
    const user = getUserById(req.auth!.sub);
    if (!user || user.disabled)
        return next(new HttpError(403, 'Current account access is required'));
    req.auth!.role = user.role;
    next();
}, requireServerAccess());
instanceCapabilitiesRouter.get('/', (req: Request, res, next) => {
    try {
        const user = getUserById(req.auth!.sub), server = getServer(req.params.serverId);
        if (!user || user.disabled)
            throw new HttpError(403, 'Current account access is required');
        if (!server)
            throw new HttpError(404, 'Instance not found');
        const permissions = getServerPermissions(user.id, user.role, server.id) ?? [];
        res.json(instanceCapabilities(server, permissions, user.role === 'admin'));
    }
    catch (error) {
        next(error);
    }
});
