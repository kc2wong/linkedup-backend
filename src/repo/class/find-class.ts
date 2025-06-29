import { Class } from '@prisma/client';
import prisma from '@repo/db';

export const findClassRepo = async (
  grade?: number,
  class_number?: string
): Promise<Class[]> => {
  try {
    const classes = await prisma.class.findMany({
      where: {
        ...(grade && { grade }), // Add grade_number condition if it's provided
        ...(class_number && { class_number }), // Add class_number condition if it's provided
      },
    });
    return classes;
  } catch (error) {
    console.error('Error fetching classes:', error);
    throw error;
  }
};
