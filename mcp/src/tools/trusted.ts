/**
 * GitHub's author_association for the repo's owner, members and collaborators: the people the Issue Fixer's
 * server tools trust (resolve_review_thread, pr_inline_comments). It must match TRUSTED_ASSOCIATIONS in the
 * goals plugin's templates, which its watches and read commands use.
 */
export const TRUSTED: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR']
