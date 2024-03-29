"""create follow model

Revision ID: 3065a825c5f8
Revises: 15c49e56770d
Create Date: 2019-02-25 14:55:48.641899

"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "3065a825c5f8"
down_revision = "15c49e56770d"
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "follows",
        sa.Column("blockhash", sa.String(), nullable=False),
        sa.Column("blocknumber", sa.Integer(), nullable=False),
        sa.Column("follower_user_id", sa.Integer(), nullable=False),
        sa.Column("followee_user_id", sa.Integer(), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("is_delete", sa.Boolean(), nullable=False),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["blockhash"],
            ["blocks.blockhash"],
        ),
        sa.ForeignKeyConstraint(
            ["blocknumber"],
            ["blocks.number"],
        ),
        sa.PrimaryKeyConstraint(
            "blockhash", "follower_user_id", "followee_user_id", "is_current"
        ),
    )
    op.alter_column(
        "reposts", "timestamp", existing_type=postgresql.TIMESTAMP(), nullable=False
    )
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.alter_column(
        "reposts", "timestamp", existing_type=postgresql.TIMESTAMP(), nullable=True
    )
    op.drop_table("follows")
    # ### end Alembic commands ###
