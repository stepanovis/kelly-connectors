// Copied into the pinned daemon. Preserve its public error types across the
// process boundary without accepting a caller-selected class or prototype.
import { ArtifactRegressionError } from './artifacts/stub-guard.js';
import { ArtifactPublicationBlockedError } from './artifacts/publication-guard.js';
import { SandboxImportedProjectError } from './projects.js';
import { LiveArtifactStoreValidationError, LiveArtifactRefreshLockError, LiveArtifactStaleRefreshError } from './live-artifacts/store.js';
import { InvalidFrozenSkillPackageError } from './strategies/od-next/frozen-skill-package.js';
import { InvalidOdNextDeviceFrameRootError } from './strategies/od-next/device-frames.js';

export function serializeKellyFileError(error) {
    const value = { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) };
    if (typeof error?.code === 'string') value.code = error.code;
    if (error instanceof ArtifactRegressionError) {
        value.details = { identifier: error.identifier, newSize: error.newSize, priorSize: error.priorSize, priorName: error.priorName };
    } else if (error instanceof ArtifactPublicationBlockedError) {
        value.details = { placeholders: [...error.placeholders] };
    } else if (error instanceof LiveArtifactStoreValidationError) {
        value.details = { issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) };
    } else if (error instanceof LiveArtifactRefreshLockError) {
        value.details = { projectId: error.projectId, artifactId: error.artifactId, lockPath: error.lockPath };
    } else if (error instanceof LiveArtifactStaleRefreshError) {
        value.details = { projectId: error.projectId, artifactId: error.artifactId, refreshId: error.refreshId,
            ...(error.lastCommittedRefreshId === undefined ? {} : { lastCommittedRefreshId: error.lastCommittedRefreshId }) };
    }
    return value;
}

export function restoreKellyFileError(value) {
    if (!value || typeof value.name !== 'string' || typeof value.message !== 'string') throw new Error('Invalid Kelly file error');
    const details = value.details;
    if (value.name === 'InvalidFrozenSkillPackageError') return new InvalidFrozenSkillPackageError(value.message);
    if (value.name === 'InvalidOdNextDeviceFrameRootError') return new InvalidOdNextDeviceFrameRootError(value.message);
    if (value.name === 'ArtifactRegressionError' && value.code === 'ARTIFACT_REGRESSION'
        && details && typeof details.identifier === 'string' && typeof details.priorName === 'string'
        && Number.isFinite(details.newSize) && Number.isFinite(details.priorSize)) {
        return new ArtifactRegressionError(value.message, details);
    }
    if (value.name === 'ArtifactPublicationBlockedError' && value.code === 'ARTIFACT_PUBLICATION_BLOCKED'
        && Array.isArray(details?.placeholders) && details.placeholders.every(item => typeof item === 'string')) {
        return new ArtifactPublicationBlockedError(details.placeholders);
    }
    if (value.name === 'SandboxImportedProjectError' && value.code === 'SANDBOX_IMPORTED_PROJECT_UNAVAILABLE') {
        return new SandboxImportedProjectError();
    }
    if (value.name === 'LiveArtifactStoreValidationError' && Array.isArray(details?.issues)
        && details.issues.every(issue => typeof issue?.path === 'string' && typeof issue.message === 'string')) {
        return new LiveArtifactStoreValidationError(value.message, details.issues);
    }
    if (value.name === 'LiveArtifactRefreshLockError' && typeof details?.projectId === 'string'
        && typeof details.artifactId === 'string' && typeof details.lockPath === 'string') {
        return new LiveArtifactRefreshLockError(value.message, details);
    }
    if (value.name === 'LiveArtifactStaleRefreshError' && typeof details?.projectId === 'string'
        && typeof details.artifactId === 'string' && typeof details.refreshId === 'string'
        && (details.lastCommittedRefreshId === undefined || typeof details.lastCommittedRefreshId === 'string')) {
        return new LiveArtifactStaleRefreshError(value.message, details);
    }
    const error = new Error(value.message);
    error.name = value.name;
    if (typeof value.code === 'string') error.code = value.code;
    return error;
}
