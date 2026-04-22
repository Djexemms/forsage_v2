use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6W97AyDjAv4thPh1WohTPkdYwdC2TuP1yfYQy1oakHZe");

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN: Pubkey = pubkey!("6oWHZAJs2HACDk6QrZhbb6f9psuJME3FhiAg1kpaKK1Z");
const GEM_MINT_ADDRESS: Pubkey = pubkey!("H2y3xXuZmCXYHgHkgmPr1q6SWBjzW3BjVzEyuEpSHn5e");
const DECIMALS: u64 = 1_000_000_000;

/// Registration + Level 1 costs
const LEVEL_COSTS: [u64; 8] = [
    100    * DECIMALS,
    200    * DECIMALS,
    400    * DECIMALS,
    800    * DECIMALS,
    1_600  * DECIMALS,
    3_200  * DECIMALS,
    6_400  * DECIMALS,
    12_800 * DECIMALS,
];

const REGISTRATION_FEE: u64 = 100 * DECIMALS;
const MAX_LEVEL: u8 = 8;
const ONE_DAY: i64 = 86_400;
const CLAIM_PERCENT: u64 = 100; // 1%

/// Payment split: 60% to referrer, 40% to vault
const REFERRER_PERCENT: u64 = 60;
const VAULT_PERCENT: u64 = 40;

/// X3 has 3 slots, X6 has 6 slots
const X3_SLOTS: u8 = 3;
const X6_SLOTS: u8 = 6;

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod forsage_v2 {
    use super::*;

    // ── Initialize global stats (once) ────────────────────────────────────
    pub fn initialize_global(ctx: Context<InitializeGlobal>) -> Result<()> {
        let stats = &mut ctx.accounts.global_stats;
        stats.authority        = *ctx.accounts.authority.key;
        stats.total_gem_collected = 0;
        stats.total_users      = 0;
        stats.total_referrals  = 0;
        stats.total_matrices   = 0;
        msg!("CoreSage global stats initialized.");
        Ok(())
    }

    // ── Initialize vault (once) ───────────────────────────────────────────
    pub fn initialize_vault(_ctx: Context<InitializeVault>) -> Result<()> {
        msg!("CoreSage vault initialized.");
        Ok(())
    }

    // ── Register Genesis Admin ────────────────────────────────────────────
    pub fn register_admin(ctx: Context<RegisterAdmin>) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;
        user_account.owner           = *ctx.accounts.user.key;
        user_account.referrer        = *ctx.accounts.user.key; // Admin refers themselves
        user_account.x3_level        = 0;
        user_account.x6_level        = 0;
        user_account.x3_slots_filled = 0;
        user_account.x6_slots_filled = 0;
        user_account.x3_matrix_count = 0;
        user_account.x6_matrix_count = 0;
        user_account.total_gem_spent = 0;
        user_account.total_earned    = 0;
        user_account.last_claim_time = 0;
        user_account.is_blocked_x3   = false;
        user_account.is_blocked_x6   = false;
        user_account.direct_referrals = 0;
        user_account.total_referrals  = 0;
        msg!("Genesis Admin account registered.");
        Ok(())
    }

    // ── Register with referrer ────────────────────────────────────────────
    /// referrer_key: the wallet address of whoever referred this user.
    /// Pass Pubkey::default() (all zeros) if no referrer.
    pub fn register(ctx: Context<Register>, referrer_key: Pubkey) -> Result<()> {
        let fee = REGISTRATION_FEE;

        // Determine actual referrer — default to admin if none supplied
        let referrer = if referrer_key == Pubkey::default() {
            ADMIN
        } else {
            referrer_key
        };

        // 60% to referrer, 40% to vault
        let referrer_amount = fee
            .checked_mul(REFERRER_PERCENT).unwrap()
            .checked_div(100).unwrap();
        let vault_amount = fee
            .checked_mul(VAULT_PERCENT).unwrap()
            .checked_div(100).unwrap();

        // Transfer 60% → referrer gem token account
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_gem_token.to_account_info(),
                    to:        ctx.accounts.referrer_gem_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            referrer_amount,
        )?;

        // Transfer 40% → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_gem_token.to_account_info(),
                    to:        ctx.accounts.vault_gem_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            vault_amount,
        )?;

        // Initialize user account
        let user_account = &mut ctx.accounts.user_account;
        user_account.owner           = *ctx.accounts.user.key;
        user_account.referrer        = referrer;
        user_account.x3_level        = 0;
        user_account.x6_level        = 0;
        user_account.x3_slots_filled = 0;
        user_account.x6_slots_filled = 0;
        user_account.x3_matrix_count = 0;
        user_account.x6_matrix_count = 0;
        user_account.total_gem_spent = fee;
        user_account.total_earned    = referrer_amount; // if they're also a referrer elsewhere
        user_account.last_claim_time = 0;
        user_account.is_blocked_x3   = false;
        user_account.is_blocked_x6   = false;
        user_account.direct_referrals = 0;
        user_account.total_referrals  = 0;

        // Update referrer's slot count + referral count
        let referrer_account = &mut ctx.accounts.referrer_account;
        referrer_account.x3_slots_filled = referrer_account
            .x3_slots_filled
            .checked_add(1)
            .ok_or(CoreSageError::Overflow)?;
        referrer_account.direct_referrals = referrer_account
            .direct_referrals
            .checked_add(1)
            .ok_or(CoreSageError::Overflow)?;
        referrer_account.total_referrals = referrer_account
            .total_referrals
            .checked_add(1)
            .ok_or(CoreSageError::Overflow)?;
        referrer_account.total_earned = referrer_account
            .total_earned
            .checked_add(referrer_amount)
            .ok_or(CoreSageError::Overflow)?;

        // Check if referrer's X3 matrix is now complete (3 slots filled)
        if referrer_account.x3_slots_filled >= X3_SLOTS {
            referrer_account.x3_slots_filled = 0; // reset for next cycle
            referrer_account.x3_matrix_count = referrer_account
                .x3_matrix_count
                .checked_add(1)
                .ok_or(CoreSageError::Overflow)?;
            msg!("X3 matrix completed for {}! Cycle #{}", referrer, referrer_account.x3_matrix_count);
        }

        // Update global stats
        let stats = &mut ctx.accounts.global_stats;
        stats.total_gem_collected = stats
            .total_gem_collected
            .checked_add(fee)
            .ok_or(CoreSageError::Overflow)?;
        stats.total_users = stats
            .total_users
            .checked_add(1)
            .ok_or(CoreSageError::Overflow)?;
        if referrer_key != Pubkey::default() {
            stats.total_referrals = stats
                .total_referrals
                .checked_add(1)
                .ok_or(CoreSageError::Overflow)?;
        }

        msg!(
            "User {} registered. Referrer: {}. Referrer got {} GEM. Vault got {} GEM.",
            ctx.accounts.user.key(),
            referrer,
            referrer_amount / DECIMALS,
            vault_amount / DECIMALS
        );
        Ok(())
    }

    // ── Upgrade level ─────────────────────────────────────────────────────
    /// matrix: 0 = X3, 1 = X6
    /// If user is blocked (hasn't upgraded), payment goes to upline instead.
    pub fn upgrade_level(ctx: Context<UpgradeLevel>, matrix: u8, next_level: u8) -> Result<()> {
        require!(matrix <= 1, CoreSageError::InvalidMatrix);
        require!(next_level >= 1 && next_level <= MAX_LEVEL, CoreSageError::InvalidLevel);

        let user_account = &mut ctx.accounts.user_account;
        let current = match matrix {
            0 => user_account.x3_level,
            1 => user_account.x6_level,
            _ => return Err(CoreSageError::InvalidMatrix.into()),
        };
        require!(next_level == current + 1, CoreSageError::InvalidLevel);

        let cost = LEVEL_COSTS[(next_level - 1) as usize];

        // 60% to referrer (or upline), 40% to vault
        let referrer_amount = cost
            .checked_mul(REFERRER_PERCENT).unwrap()
            .checked_div(100).unwrap();
        let vault_amount = cost
            .checked_mul(VAULT_PERCENT).unwrap()
            .checked_div(100).unwrap();

        // Transfer 60% → referrer gem token account
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_gem_token.to_account_info(),
                    to:        ctx.accounts.referrer_gem_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            referrer_amount,
        )?;

        // Transfer 40% → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_gem_token.to_account_info(),
                    to:        ctx.accounts.vault_gem_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            vault_amount,
        )?;

        // Update user
        match matrix {
            0 => {
                user_account.x3_level     = next_level;
                user_account.is_blocked_x3 = false;
                // Update X6 slots on upgrade
                user_account.x6_slots_filled = user_account
                    .x6_slots_filled
                    .checked_add(1)
                    .ok_or(CoreSageError::Overflow)?;
                // Check X6 matrix completion (6 slots)
                if user_account.x6_slots_filled >= X6_SLOTS {
                    user_account.x6_slots_filled = 0;
                    user_account.x6_matrix_count = user_account
                        .x6_matrix_count
                        .checked_add(1)
                        .ok_or(CoreSageError::Overflow)?;
                    msg!("X6 matrix completed! Cycle #{}", user_account.x6_matrix_count);
                }
            },
            1 => {
                user_account.x6_level     = next_level;
                user_account.is_blocked_x6 = false;
            },
            _ => {}
        }

        user_account.total_gem_spent = user_account
            .total_gem_spent
            .checked_add(cost)
            .ok_or(CoreSageError::Overflow)?;

        // Update referrer earned
        let referrer_account = &mut ctx.accounts.referrer_account;
        referrer_account.total_earned = referrer_account
            .total_earned
            .checked_add(referrer_amount)
            .ok_or(CoreSageError::Overflow)?;

        // Global stats
        let stats = &mut ctx.accounts.global_stats;
        stats.total_gem_collected = stats
            .total_gem_collected
            .checked_add(cost)
            .ok_or(CoreSageError::Overflow)?;

        msg!(
            "User {} upgraded {} to Level {}. Cost: {} GEM. Referrer got {} GEM.",
            ctx.accounts.user.key(),
            if matrix == 0 { "X3" } else { "X6" },
            next_level,
            cost / DECIMALS,
            referrer_amount / DECIMALS
        );
        Ok(())
    }

    // ── Daily claim ───────────────────────────────────────────────────────
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let user_account = &mut ctx.accounts.user_account;

        require!(
            now >= user_account.last_claim_time + ONE_DAY,
            CoreSageError::ClaimNotReady
        );

        let claim_amount = user_account
            .total_gem_spent
            .checked_div(CLAIM_PERCENT)
            .ok_or(CoreSageError::Overflow)?;

        require!(claim_amount > 0, CoreSageError::NothingToClaim);
        require!(
            ctx.accounts.vault_gem_token.amount >= claim_amount,
            CoreSageError::InsufficientVaultFunds
        );

        let bump = ctx.bumps.vault_gem_token;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault_gem_token.to_account_info(),
                    to:        ctx.accounts.user_gem_token.to_account_info(),
                    authority: ctx.accounts.vault_gem_token.to_account_info(),
                },
                signer_seeds,
            ),
            claim_amount,
        )?;

        user_account.last_claim_time = now;
        user_account.total_earned = user_account
            .total_earned
            .checked_add(claim_amount)
            .ok_or(CoreSageError::Overflow)?;

        msg!("User {} claimed {} GEM.", ctx.accounts.user.key(), claim_amount / DECIMALS);
        Ok(())
    }

    // ── Admin withdraw ────────────────────────────────────────────────────
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(ctx.accounts.admin.key() == ADMIN, CoreSageError::Unauthorized);

        let bump = ctx.bumps.vault_gem_token;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault_gem_token.to_account_info(),
                    to:        ctx.accounts.admin_gem_token.to_account_info(),
                    authority: ctx.accounts.vault_gem_token.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        msg!("Admin withdrew {} GEM.", amount / DECIMALS);
        Ok(())
    }

    // ── Close user account ────────────────────────────────────────────────
    pub fn close_user_account(_ctx: Context<CloseUserAccount>) -> Result<()> {
        msg!("User account closed.");
        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        init, payer = authority,
        space = GlobalStats::SIZE,
        seeds = [b"global_stats"], bump
    )]
    pub global_stats: Account<'info, GlobalStats>,
    #[account(mut, constraint = authority.key() == ADMIN @ CoreSageError::Unauthorized)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init, payer = authority,
        token::mint = gem_mint,
        token::authority = vault_gem_token,
        seeds = [b"vault"], bump
    )]
    pub vault_gem_token: Account<'info, TokenAccount>,
    /// CHECK: GEM mint
    pub gem_mint: UncheckedAccount<'info>,
    #[account(mut, constraint = authority.key() == ADMIN @ CoreSageError::Unauthorized)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterAdmin<'info> {
    #[account(
        init, payer = user,
        space = UserState::SIZE,
        seeds = [b"forsage_user", user.key().as_ref()], bump
    )]
    pub user_account: Account<'info, UserState>,
    #[account(mut, constraint = user.key() == ADMIN @ CoreSageError::Unauthorized)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(
        init, payer = user,
        space = UserState::SIZE,
        seeds = [b"forsage_user", user.key().as_ref()], bump
    )]
    pub user_account: Account<'info, UserState>,

    /// The referrer's user account — must already be registered
    /// If no referrer, pass the admin's user account
    #[account(
        mut,
        seeds = [b"forsage_user", referrer_account.owner.as_ref()], bump
    )]
    pub referrer_account: Account<'info, UserState>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"global_stats"], bump)]
    pub global_stats: Account<'info, GlobalStats>,

    #[account(
        mut,
        constraint = user_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner,
        constraint = user_gem_token.owner == user.key() @ CoreSageError::InvalidTokenOwner
    )]
    pub user_gem_token: Account<'info, TokenAccount>,

    /// Referrer's GEM token account — receives 60%
    #[account(
        mut,
        constraint = referrer_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub referrer_gem_token: Account<'info, TokenAccount>,

    #[account(
        mut, seeds = [b"vault"], bump,
        constraint = vault_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub vault_gem_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpgradeLevel<'info> {
    #[account(
        mut,
        seeds = [b"forsage_user", user.key().as_ref()], bump,
        constraint = user_account.owner == user.key() @ CoreSageError::Unauthorized
    )]
    pub user_account: Account<'info, UserState>,

    /// Referrer's account — receives 60% of upgrade payment
    #[account(
        mut,
        seeds = [b"forsage_user", referrer_account.owner.as_ref()], bump
    )]
    pub referrer_account: Account<'info, UserState>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"global_stats"], bump)]
    pub global_stats: Account<'info, GlobalStats>,

    #[account(
        mut,
        constraint = user_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner,
        constraint = user_gem_token.owner == user.key() @ CoreSageError::InvalidTokenOwner
    )]
    pub user_gem_token: Account<'info, TokenAccount>,

    /// Referrer's GEM token account — receives 60%
    #[account(
        mut,
        constraint = referrer_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub referrer_gem_token: Account<'info, TokenAccount>,

    #[account(
        mut, seeds = [b"vault"], bump,
        constraint = vault_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub vault_gem_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [b"forsage_user", user.key().as_ref()], bump,
        constraint = user_account.owner == user.key() @ CoreSageError::Unauthorized
    )]
    pub user_account: Account<'info, UserState>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner,
        constraint = user_gem_token.owner == user.key() @ CoreSageError::InvalidTokenOwner
    )]
    pub user_gem_token: Account<'info, TokenAccount>,
    #[account(
        mut, seeds = [b"vault"], bump,
        constraint = vault_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub vault_gem_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, constraint = admin.key() == ADMIN @ CoreSageError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner,
        constraint = admin_gem_token.owner == admin.key() @ CoreSageError::InvalidTokenOwner
    )]
    pub admin_gem_token: Account<'info, TokenAccount>,
    #[account(
        mut, seeds = [b"vault"], bump,
        constraint = vault_gem_token.mint == GEM_MINT_ADDRESS @ CoreSageError::InvalidTokenOwner
    )]
    pub vault_gem_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseUserAccount<'info> {
    #[account(
        mut, close = user,
        seeds = [b"forsage_user", user.key().as_ref()], bump
    )]
    pub user_account: Account<'info, UserState>,
    #[account(mut)]
    pub user: Signer<'info>,
}

// ─── Account Data Structs ─────────────────────────────────────────────────────

#[account]
pub struct UserState {
    pub owner:            Pubkey,   // 32
    pub referrer:         Pubkey,   // 32
    pub x3_level:         u8,       //  1
    pub x6_level:         u8,       //  1
    pub x3_slots_filled:  u8,       //  1  slots filled in current X3 matrix
    pub x6_slots_filled:  u8,       //  1  slots filled in current X6 matrix
    pub x3_matrix_count:  u32,      //  4  how many X3 matrices completed
    pub x6_matrix_count:  u32,      //  4  how many X6 matrices completed
    pub total_gem_spent:  u64,      //  8
    pub total_earned:     u64,      //  8
    pub last_claim_time:  i64,      //  8
    pub is_blocked_x3:    bool,     //  1
    pub is_blocked_x6:    bool,     //  1
    pub direct_referrals: u32,      //  4
    pub total_referrals:  u32,      //  4
}

impl UserState {
    // 8 + 32 + 32 + 1 + 1 + 1 + 1 + 4 + 4 + 8 + 8 + 8 + 1 + 1 + 4 + 4 = 118
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 1 + 4 + 4 + 8 + 8 + 8 + 1 + 1 + 4 + 4;
}

#[account]
pub struct GlobalStats {
    pub authority:           Pubkey,  // 32
    pub total_gem_collected: u64,     //  8
    pub total_users:         u64,     //  8
    pub total_referrals:     u64,     //  8
    pub total_matrices:      u64,     //  8
}

impl GlobalStats {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum CoreSageError {
    #[msg("Level must be upgraded sequentially (current + 1).")]
    InvalidLevel,
    #[msg("Matrix must be 0 (X3) or 1 (X6).")]
    InvalidMatrix,
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
    #[msg("Token account owner does not match signer.")]
    InvalidTokenOwner,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("You must wait 24 hours between claims.")]
    ClaimNotReady,
    #[msg("Nothing to claim.")]
    NothingToClaim,
    #[msg("Vault has insufficient funds for this claim.")]
    InsufficientVaultFunds,
    #[msg("User is blocked at this level. Upgrade to continue earning.")]
    UserBlocked,
}