import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(1, 'Password is required'),
}).refine((data) => !!data.username || !!data.email, {
  message: 'Username or Email is required',
  path: ['email'],
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});
