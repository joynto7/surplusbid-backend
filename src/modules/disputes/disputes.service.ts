import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { findLotById } from '../lots/lots.service';

export async function createDispute(raisedById: string, data: { lotId: string; reason: string; description: string }) {
  await findLotById(data.lotId);
  return prisma.dispute.create({ data: { ...data, raisedById } });
}

export async function resolveDispute(disputeId: string, resolvedById: string, data: { status: 'RESOLVED' | 'REJECTED'; resolutionNote: string }) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new ApiError(404, 'Dispute not found');

  const updated = await prisma.dispute.update({
    where: { id: disputeId },
    data: { status: data.status, resolutionNote: data.resolutionNote, resolvedById, resolvedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: resolvedById, action: 'RESOLVE_DISPUTE', entityType: 'Dispute', entityId: disputeId, metadata: data },
  });

  return updated;
}
