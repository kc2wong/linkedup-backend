import { CreateAchievementDto } from '@api/achievement/achievement-schema';
import {
  validateActivity,
  validateStudent,
} from '@service/achievement/shared/achievement-validation';
import { AuthenticatedUser } from '@type/authentication';
import { currentDatetime } from '@util/datetime-util';
import { dto2Entity as userRoleDto2Entity } from '@service/user/mapper/user-role-mapper';
import { dto2Entity as achievementSubmissionRoleDto2Entity } from '@service/activity/mapper/achievement-submission-role-mapper';
import {
  creationDto2Entity as creationDto2ApprovalEntity,
  entity2Dto as approvalEntity2Dto,
} from '@service/achievement-approval/mapper/achievement-approval-mapper';

import { approvalBucketName, copyObject } from '@util/s3-util';
import {
  deleteAchievementApprovalRepo,
  findAchievementApprovalRepo,
} from '@repo/achievement-approval-repo';
import { AchievementApprovalStatus } from '@prisma/client';
import { createAchievementApprovalRepo } from '@repo/achievement-approval/create-achievement-approval';
import { findAchievementAttachmentByAchievementOidRepo } from '@repo/achievement/find-achievement-attachment';
import { findAchievementRepo } from '@repo/achievement-repo';
import { AchievementApprovalDto } from '@api/achievement-approval/achievement-approval-schema';
import { findAchievementApprovalReviewByAchievementApprovalOidRepo } from '@repo/achievement-approval/find-achievement-approval-review';

export const createAchievementApprovalService = async (
  authenticatedUser: AuthenticatedUser,
  achievementCreationDto: CreateAchievementDto,
  deleteExisting: boolean = false
): Promise<AchievementApprovalDto> => {
  const now = currentDatetime();

  // Validation
  const student = await validateStudent(
    achievementCreationDto.studentId,
    authenticatedUser
  );
  const { activity, submissionRole } = await validateActivity(
    achievementCreationDto.activityId,
    { userRole: userRoleDto2Entity(authenticatedUser.userRole) }
  );

  // Map DTOs to entities
  const approvalEntity = creationDto2ApprovalEntity(
    achievementCreationDto,
    student,
    activity,
    achievementSubmissionRoleDto2Entity(submissionRole),
    achievementCreationDto.attachment.length
  );

  // Find if achievement approval already exists
  const findQuery = {
    studentId: achievementCreationDto.studentId,
    activityId: achievementCreationDto.activityId,
    role: submissionRole,
    offset: 0,
    limit: 1,
  };
  const existingApproval = (await findAchievementApprovalRepo(findQuery))
    .data[0]?.achievementApproval;
  approvalEntity.achievement_oid = existingApproval?.oid;

  const existingReview = existingApproval
    ? await findAchievementApprovalReviewByAchievementApprovalOidRepo(
        existingApproval.oid
      )
    : [];
  if (existingApproval !== undefined) {
    if (deleteExisting) {
      deleteAchievementApprovalRepo(
        existingApproval.achievement_oid!,
        existingApproval.version!
      );
    } else {
      // exception
    }
  }

  const existingAchievement = (await findAchievementRepo(findQuery)).data[0]
    ?.achievement;
  const existingAttachment = existingAchievement
    ? await findAchievementAttachmentByAchievementOidRepo(
        existingAchievement.oid
      )
    : [];
  const existingAttachmentMap = new Map(
    existingAttachment.map((atch) => [atch.object_key, atch])
  );

  const prefix = `activity/${achievementCreationDto.activityId}/student/${achievementCreationDto.studentId}`;
  // 🔄 Copy new attachment from upload bucket to approval bucket
  const attachments = await Promise.all(
    achievementCreationDto.attachment.map(async (a) => {
      const existingAtch = existingAttachmentMap.get(a.objectKey);
      if (existingAtch === undefined) {
        // new uploaded attachment
        const fileName = a.objectKey.split('/').pop()!;
        const objectKey = `${prefix}/${fileName}`;
        const fileSize = await copyObject(
          approvalBucketName,
          `${a.bucketName}/${a.objectKey}`,
          objectKey
        );
        return {
          file_name: a.fileName,
          bucket_name: approvalBucketName,
          object_key: objectKey,
          file_size: fileSize,
        };
      } else {
        return {
          file_name: a.fileName,
          object_key: a.objectKey,
          bucket_name: existingAtch.bucket_name,
          file_size: existingAtch.file_size,
        };
      }
    })
  );

  const payload = {
    ...approvalEntity,
    status: 'Pending' as AchievementApprovalStatus,
    updated_by_user_oid: authenticatedUser.oid,
    updated_at: now,
  };

  const result = await createAchievementApprovalRepo(
    {
      ...payload,
      created_by_user_oid: authenticatedUser.oid,
      created_at: now,
      version: 1,
    },
    attachments,
    existingReview
  );

  return approvalEntity2Dto(result, student, activity);
};
