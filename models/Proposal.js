// models/Proposal.js
const mongoose = require('mongoose');

const ProposalSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200
    },
    description: {
        type: String,
        required: true,
        trim: true,
        maxlength: 2000
    },
    options: {
        type: [String],
        required: true,
        validate: {
            validator: (arr) => arr.length >= 2 && arr.length <= 10,
            message: 'Deve ter entre 2 e 10 opções'
        }
    },
    votes: {
        type: Map,
        of: Number,
        default: {}
    },
    voters: {
        type: [String], // IP + fingerprint hash
        default: []
    },
    creator: {
        type: String,
        default: '0xQ' + Math.random().toString(36).substring(2, 9).toUpperCase()
    },
    creatorIp: {
        type: String,
        select: false
    },
    ended: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    endedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Índice pra ordenar por data
ProposalSchema.index({ createdAt: -1 });

// Método: votar
ProposalSchema.methods.vote = function(voterHash, option) {
    if (this.ended) throw new Error('Proposta encerrada');
    if (!this.options.includes(option)) throw new Error('Opção inválida');
    if (this.voters.includes(voterHash)) throw new Error('Você já votou nesta proposta');

    const current = this.votes.get(option) || 0;
    this.votes.set(option, current + 1);
    this.voters.push(voterHash);
    return this.save();
};

// Método: encerrar
ProposalSchema.methods.end = function() {
    if (this.ended) throw new Error('Proposta já encerrada');
    this.ended = true;
    this.endedAt = new Date();
    return this.save();
};

// Método: toPublic
ProposalSchema.methods.toPublic = function() {
    const votesObj = {};
    if (this.votes instanceof Map) {
        for (const [k, v] of this.votes) votesObj[k] = v;
    } else {
        Object.assign(votesObj, this.votes || {});
    }

    const totalVotes = Object.values(votesObj).reduce((a, b) => a + b, 0);

    return {
        id: this._id.toString(),
        title: this.title,
        description: this.description,
        options: this.options,
        votes: votesObj,
        totalVotes,
        votersCount: this.voters.length,
        creator: this.creator,
        ended: this.ended,
        createdAt: this.createdAt,
        endedAt: this.endedAt
    };
};

// Índice pra busca por ativas
ProposalSchema.statics.getActive = function() {
    return this.find({ ended: false }).sort({ createdAt: -1 });
};

ProposalSchema.statics.getStats = async function() {
    const total = await this.countDocuments();
    const active = await this.countDocuments({ ended: false });
    const ended = await this.countDocuments({ ended: true });

    const proposals = await this.find({}, 'votes voters');
    let totalVotes = 0;
    let activeVoters = 0;

    proposals.forEach((p) => {
        const votes = p.votes instanceof Map
            ? Array.from(p.votes.values()).reduce((a, b) => a + b, 0)
            : Object.values(p.votes || {}).reduce((a, b) => a + b, 0);
        totalVotes += votes;
        if (!p.ended) activeVoters += votes;
    });

    return { total, active, ended, totalVotes, activeVoters };
};

module.exports = mongoose.model('Proposal', ProposalSchema);
