import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { RolesRepository } from '../repositories/roles.repository';

/**
 * How many roles may be created by hand. Seeded roles (is_system = 1) are
 * built into the system and are not counted against this limit.
 */
const MAX_CUSTOM_ROLES = 2;

export interface RoleInput {
  name?: string;
  description?: string;
  permissionIds?: number[];
}

export interface PermissionInput {
  code?: string;
  module?: string;
  description?: string;
}

export class RolesService {
  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------
  static async getAll() {
    const roles = await RolesRepository.findAllWithUserCount();

    return Promise.all(
      roles.map(async (role) => ({
        ...role,
        user_count: Number(role.user_count || 0),
        permissions: await RolesRepository.findPermissionsByRole(role.id),
      }))
    );
  }

  static async getById(roleId: number) {
    const role = await RolesRepository.findByIdWithUserCount(roleId);
    if (!role) {
      throw AppError.notFound('Role not found');
    }

    return {
      ...role,
      user_count: Number(role.user_count || 0),
      permissions: await RolesRepository.findPermissionsByRole(roleId),
    };
  }

  static async create(input: RoleInput, actorId: number) {
    const { name, description, permissionIds } = input;

    if (!name || !name.trim()) {
      throw AppError.badRequest('Role name is required');
    }

    const trimmedName = name.trim();

    if (await RolesRepository.findByName(trimmedName)) {
      throw AppError.conflict(`Role '${trimmedName}' already exists`);
    }

    if ((await RolesRepository.countCustomRoles()) >= MAX_CUSTOM_ROLES) {
      throw AppError.badRequest(
        `Role limit reached. A maximum of ${MAX_CUSTOM_ROLES} custom roles can be created. Delete an existing custom role before adding another.`
      );
    }

    let newRoleId = 0;

    await dbService.transaction(async () => {
      newRoleId = await RolesRepository.insertRole(
        trimmedName,
        description ? description.trim() : null
      );

      if (Array.isArray(permissionIds) && permissionIds.length > 0) {
        await RolesRepository.insertRolePermissions(newRoleId, permissionIds);
      }
    });

    await AuditService.log({
      userId: actorId,
      action: 'ROLE_CREATED',
      module: 'ROLES',
      recordId: newRoleId,
      newValues: { name: trimmedName, description, permissionIds },
    });

    return {
      id: newRoleId,
      name: trimmedName,
      description: description || null,
      is_system: 0,
      user_count: 0,
      permissions: await RolesRepository.findPermissionsByRole(newRoleId),
    };
  }

  static async update(roleId: number, input: RoleInput, actorId: number) {
    const { name, description, permissionIds } = input;

    const role = await RolesRepository.findById(roleId);
    if (!role) {
      throw AppError.notFound('Role not found');
    }

    const trimmedName = name ? name.trim() : role.name;

    if (name && trimmedName.toLowerCase() !== role.name.toLowerCase()) {
      if (await RolesRepository.findByName(trimmedName, roleId)) {
        throw AppError.conflict(`Role name '${trimmedName}' is already in use`);
      }
    }

    await dbService.transaction(async () => {
      await RolesRepository.updateRole(
        roleId,
        trimmedName,
        description !== undefined ? description : role.description
      );

      if (Array.isArray(permissionIds)) {
        await RolesRepository.replaceRolePermissions(roleId, permissionIds);
      }
    });

    await AuditService.log({
      userId: actorId,
      action: 'ROLE_UPDATED',
      module: 'ROLES',
      recordId: roleId,
      oldValues: { name: role.name, description: role.description },
      newValues: { name: trimmedName, description, permissionIds },
    });

    return {
      id: roleId,
      name: trimmedName,
      description: description !== undefined ? description : role.description,
      user_count: await RolesRepository.countUsersByRole(roleId),
      permissions: await RolesRepository.findPermissionsByRole(roleId),
    };
  }

  static async remove(roleId: number, actorId: number) {
    const role = await RolesRepository.findById(roleId);
    if (!role) {
      throw AppError.notFound('Role not found');
    }

    // A role still carrying staff cannot go: those users would be left
    // pointing at a role_id that no longer resolves.
    const userCount = await RolesRepository.countUsersByRole(roleId);
    if (userCount > 0) {
      throw AppError.badRequest(
        `Cannot delete role '${role.name}': ${userCount} staff user(s) are currently assigned to this role. Please reassign their roles first.`
      );
    }

    await dbService.transaction(async () => {
      await RolesRepository.deleteRolePermissionsByRole(roleId);
      await RolesRepository.deleteRole(roleId);
    });

    await AuditService.log({
      userId: actorId,
      action: 'ROLE_DELETED',
      module: 'ROLES',
      recordId: roleId,
      oldValues: { name: role.name },
    });

    return { result: { id: roleId, deleted: true }, name: role.name };
  }

  static async updatePermissions(roleId: number, permissionIds: number[], actorId: number) {
    const role = await RolesRepository.findById(roleId);
    if (!role) {
      throw AppError.notFound('Role not found');
    }

    await dbService.transaction(async () => {
      await RolesRepository.replaceRolePermissions(
        roleId,
        Array.isArray(permissionIds) ? permissionIds : []
      );
    });

    await AuditService.log({
      userId: actorId,
      action: 'ROLE_PERMISSIONS_UPDATED',
      module: 'ROLES',
      recordId: roleId,
      newValues: { roleId, permissionIds },
    });

    return { roleId, updated: true };
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------
  static async getPermissions() {
    return RolesRepository.findAllPermissions();
  }

  static async createPermission(input: PermissionInput) {
    const { code, module, description } = input;

    if (!code || !module) {
      throw AppError.badRequest('Permission code and module are required');
    }

    const trimmedCode = code.trim().toLowerCase();
    const trimmedModule = module.trim().toUpperCase();

    if (await RolesRepository.findPermissionByCode(trimmedCode)) {
      throw AppError.conflict(`Permission code '${trimmedCode}' already exists`);
    }

    const id = await RolesRepository.insertPermission(
      trimmedCode,
      trimmedModule,
      description ? description.trim() : null
    );

    return {
      id,
      code: trimmedCode,
      module: trimmedModule,
      description: description || null,
    };
  }

  static async removePermission(permissionId: number) {
    const permission = await RolesRepository.findPermissionById(permissionId);
    if (!permission) {
      throw AppError.notFound('Permission not found');
    }

    await dbService.transaction(async () => {
      await RolesRepository.deleteRolePermissionsByPermission(permissionId);
      await RolesRepository.deletePermission(permissionId);
    });

    return { result: { id: permissionId, deleted: true }, code: permission.code };
  }
}
